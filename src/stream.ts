import assert from 'node:assert';
import type { ReadableOptions } from 'node:stream';
import {
  BatchWriteCommand,
  type BatchWriteCommandInput,
  type BatchWriteCommandOutput,
  type DynamoDBDocument,
  QueryCommand,
  type QueryCommandInput,
  type QueryCommandOutput,
  ScanCommand,
  type ScanCommandInput,
  type ScanCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type { NativeAttributeValue } from '@aws-sdk/util-dynamodb';
import { isThrottlingError } from '@smithy/service-error-classification';
import type { SdkError } from '@smithy/types';
import createDebug from 'debug';
import { type ParseResponseOptions, parseResponse } from './responses.ts';
import { DynoReadableStream } from './streams/dyno-readable-stream.ts';
import { type BatchWriteRequestItem, DynoWritableStream } from './streams/dyno-writable-stream.ts';
import type { ParallelWritableOptions } from './streams/parallel-writable.ts';
import type { NativeAttributeMap } from './types.ts';
import { calculateDelay, getItemSize } from './util.ts';

const log = createDebug('dyno-stream');
const logRead = log.extend('read');
const logPut = log.extend('put');

export type ScanInput = Omit<ScanCommandInput, 'TableName'> & {
  TableName: string;
  /**
   * Maximum number of pages of scan results to request. Set to `Infinity` to return all available data.
   */
  Pages?: number;
};

export type ScanOutput = Omit<ScanCommandOutput, '$metadata'>;

export type QueryInput = Omit<QueryCommandInput, 'TableName'> & {
  TableName: string;
  /**
   * Maximum number of pages of scan results to request. Set to `Infinity` to return all available data.
   */
  Pages?: number;
};

export type QueryOutput = Omit<QueryCommandOutput, '$metadata'>;

export type ReadStreamOptions = ReadableOptions &
  ParseResponseOptions & {
    mode?: 'scan' | 'query';
    pageSize?: number;
  };

function getLimit(limit?: number, pageSize?: number) {
  if (limit !== undefined && pageSize !== undefined) {
    return Math.min(limit, pageSize);
  }

  return limit ?? pageSize;
}

/**
 * Create a scan stream, reading the whole table unless limited.
 */
export function createReadStream(
  client: DynamoDBDocument,
  {
    TableName,
    Pages = Number.POSITIVE_INFINITY,
    Limit,
    ExclusiveStartKey,
    ...commandInput
  }: ScanInput | QueryInput,
  { mode = 'scan', pageSize, noBuffers, ...readableOptions }: ReadStreamOptions = {},
) {
  logRead('createReadStream');

  assert(Pages > 0, 'Pages must be an integer greater than 0');

  let pending = false;
  let items: NativeAttributeMap[] = [];

  function push() {
    logRead('push', 'items:', items.length);

    let status = true;

    while (status && items.length) {
      status = readable.push(items.shift());
    }

    return status;
  }

  function finish() {
    logRead(
      'finish',
      'count:',
      readable.Count,
      'scanned:',
      readable.ScannedCount,
      'readableLength:',
      readable.readableLength,
      'highWater:',
      readable.readableHighWaterMark,
    );

    readable.push(null);
  }

  function request(nextLimit?: number) {
    logRead('request', 'limit:', nextLimit);

    pending = true;

    let command: ScanCommand | QueryCommand;

    if (mode === 'scan') {
      command = new ScanCommand({
        ...commandInput,
        TableName,
        ExclusiveStartKey: readable.LastEvaluatedKey,
        Limit: getLimit(nextLimit, pageSize),
      });
    } else {
      command = new QueryCommand({
        ...commandInput,
        TableName,
        ExclusiveStartKey: readable.LastEvaluatedKey,
        Limit: getLimit(nextLimit, pageSize),
      });
    }

    logRead('sending command input:', command.input);

    client.send(
      command,
      (
        error: SdkError | undefined,
        response: ScanCommandOutput | QueryCommandOutput | undefined,
      ) => {
        logRead('got response');

        pending = false;

        if (error) {
          logRead('error', { error, response });
          readable.emit('error', error);
          return;
        }

        if (!response) {
          logRead('empty');
          readable.update();
          read();
          return;
        }

        parseResponse(response, { noBuffers });

        if (response.Items) {
          items = [...response.Items];
        }

        readable.update(response);

        if (readable.hasNextPage()) {
          logRead('has another page');
          read();
          return;
        }

        read();
      },
    );
  }

  function read() {
    logRead('read', 'pending:', pending, 'items:', items.length);

    /**
     * If status is false, highwater mark has been reached and we should not
     * push more data until `read` is called again.
     */
    const status = push();

    if (items.length) {
      return;
    }

    const nextLimit = readable.getNextLimit();

    if (readable.isLastPage() || (nextLimit !== undefined && nextLimit <= 0)) {
      finish();
      return;
    }

    if (status && !pending) {
      request(nextLimit);
    }
  }

  const readable = new DynoReadableStream(
    { objectMode: true, read, ...readableOptions },
    { TableName, LastEvaluatedKey: ExclusiveStartKey, Limit, Pages },
  );

  return readable;
}

export type PutStreamInput = Omit<BatchWriteCommandInput, 'TableName' | 'RequestItems'> & {
  TableName: string;
};

export type PutStreamOptions = ParallelWritableOptions & {
  pageSize?: number;
  maxRetries?: number;
  maxBatchSize?: number;
  docMode?: boolean;
};

/**
 * Create a put stream, writing batches to DynamoDB with support for valid
 * request size checking. Supports parallel writes and delayed retry of unprocessed items.
 */
export function createPutStream(
  client: DynamoDBDocument,
  commandInput: PutStreamInput,
  {
    concurrency = 5,
    pageSize = 25,
    maxRetries = 5,
    maxBatchSize = 16 * 1024 * 1024,
    ...writableOptions
  }: PutStreamOptions = {},
) {
  const { TableName } = commandInput;

  let pageItems: BatchWriteRequestItem[] = [];
  let pageItemsSize = 0;

  const resetPageItems = () => {
    pageItemsSize = 0;
    pageItems = [];
  };

  const pushPageItem = (item: Record<string, NativeAttributeValue>, itemSize: number) => {
    pageItemsSize += itemSize;
    pageItems.push({ PutRequest: { Item: item } });
  };

  function write(
    item: Record<string, NativeAttributeValue>,
    _encoding: BufferEncoding,
    callback: (error?: Error) => void,
  ) {
    const nextItemSize = getItemSize(item);
    const nextPageItemsSize = pageItemsSize + nextItemSize;

    // If adding the next item pushes the batch over the limit, write and push onto the next page
    if (nextPageItemsSize > maxBatchSize) {
      logPut('write - writing page', { maxBatchSize, nextPageItemsSize });

      writePage(pageItems, 0, callback);
      resetPageItems();
      pushPageItem(item, nextItemSize);
      return;
    }

    pushPageItem(item, nextItemSize);

    // If the page size is hit, write
    if (pageItems.length === pageSize) {
      logPut('write - writing page', {
        pageSize,
        pageItemsLength: pageItems.length,
      });

      writePage(pageItems, 0, callback);
      resetPageItems();
      return;
    }

    callback();
  }

  function _done(callback: (error?: Error) => void) {
    return (error?: Error) => {
      writable.done();
      callback(error);
    };
  }

  function final(callback: (error?: Error) => void) {
    const done = _done(callback);

    if (!pageItems.length) {
      done();
      return;
    }

    logPut('final - writing page', { pageItemsLength: pageItems.length });

    writePage(pageItems, 0, done);

    pageItems = [];
  }

  function writePage(
    items: BatchWriteRequestItem[],
    retryCount: number,
    callback: (error?: Error) => void,
  ): void {
    const command = new BatchWriteCommand({
      RequestItems: {
        [TableName]: items,
      },
      ...commandInput,
    });

    logPut('sending command', { retryCount });

    client.send(command, (error?: SdkError, response?: BatchWriteCommandOutput) => {
      if (error) {
        logPut({ error, response });
      }

      // In these cases the items were not processed, so retry the items originally provided
      if (error && isThrottlingError(error) && !response) {
        setTimeout(() => {
          writePage(items, retryCount + 1, callback);
        }, calculateDelay(retryCount));
        return;
      }

      writable.update(response, items);

      const writableUnprocessedItems = writable.UnprocessedItems;

      // If there are any dangling items and retries are left, attempt to process them
      if (writableUnprocessedItems?.length && retryCount < maxRetries) {
        const page = writableUnprocessedItems.splice(0, pageSize);
        setTimeout(() => {
          writePage(page, retryCount + 1, callback);
        }, calculateDelay(retryCount));
        return;
      }

      callback(error);
    });
  }

  const writable = new DynoWritableStream({
    TableName,
    concurrency,
    write,
    final,
    objectMode: true,
    ...writableOptions,
  });

  return writable;
}
