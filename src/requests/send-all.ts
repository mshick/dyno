import type {
  BatchGetCommandInput,
  BatchGetCommandOutput,
  BatchWriteCommandInput,
  BatchWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import createDebug from 'debug';
import fastq, { type worker as QueueWorker } from 'fastq';
import { ensureError } from '../util.ts';
import type {
  BatchCommandInput,
  BatchCommandOutput,
  BatchResult,
  CompactOptions,
  Fetcher,
  RequestFactory,
} from './types.ts';

const log = createDebug('dyno-requests');

type SendAllCallback<
  I extends BatchCommandInput,
  O extends BatchCommandOutput = I extends BatchGetCommandInput
    ? BatchGetCommandOutput
    : BatchWriteCommandOutput,
> = (
  error: Array<Error | null> | undefined,
  data: Array<SendAllResult<O> | null>,
  unprocessed?: SendAllBatch<I>,
) => void;

type SendAllCompactCallback<I extends BatchCommandInput> = (
  error: Array<Error | null> | undefined,
  data: Array<SendAllCompactResult<I> | null>,
  unprocessed?: SendAllBatch<I>,
) => void;

export type SendAllResult<O extends BatchCommandOutput> = Omit<O, '$metadata'>;

export type SendAllGetOutput = SendAllResult<BatchGetCommandOutput>;
export type SendAllWriteOutput = SendAllResult<BatchWriteCommandOutput>;
export type SendAllCompactGetOutput = Omit<
  SendAllResult<BatchGetCommandOutput>,
  'Responses' | 'UnprocessedKeys'
> & {
  Responses?: NonNullable<BatchGetCommandOutput['Responses']>[string];
  UnprocessedKeys?: NonNullable<BatchGetCommandOutput['UnprocessedKeys']>[string];
};

export type SendAllCompactWriteOutput = Omit<
  SendAllResult<BatchWriteCommandOutput>,
  'UnprocessedItems'
> & {
  UnprocessedItems?: NonNullable<BatchWriteCommandOutput['UnprocessedItems']>[string];
};

export type SendAllCompactResult<I extends BatchCommandInput> = I extends BatchGetCommandInput
  ? SendAllCompactGetOutput
  : SendAllCompactWriteOutput;

export type SendAllOptions = { concurrency?: number };

/**
 * Given a set of requests, this function sends them all at specified concurrency.
 * Generally, this function is not called directly, but is bound to an array of
 * requests with the first two parameters wired to specific values.
 */
function _sendAll<I extends BatchCommandInput>(
  requests: Array<Fetcher<I> | null>,
  load: SendAllBatch<I>['load'],
  options: SendAllOptions,
  callback: SendAllCallback<I>,
): void;
function _sendAll<I extends BatchCommandInput>(
  requests: Array<Fetcher<I> | null>,
  load: SendAllBatch<I>['load'],
  options: SendAllOptions & { compact: true },
  callback: SendAllCompactCallback<I>,
): void;
function _sendAll<
  I extends BatchCommandInput,
  O extends BatchCommandOutput = I extends BatchGetCommandInput
    ? BatchGetCommandOutput
    : BatchWriteCommandOutput,
>(
  requests: Array<Fetcher<I> | null>,
  load: SendAllBatch<I>['load'],
  options: SendAllOptions & CompactOptions,
  callback: SendAllCallback<I> | SendAllCompactCallback<I>,
) {
  const l = log.extend('sendAll');

  const { concurrency = 1 } = options;

  l('requests:', requests.length, 'concurrency:', concurrency);

  const worker: QueueWorker<unknown, Fetcher<I> | null, BatchResult> = (request, done) => {
    if (!request) {
      done(null);
      return;
    }

    void request.send().then((res) => {
      done(null, res as BatchResult);
    });
  };

  const drain = (results: Array<BatchResult | null>) => {
    return () => {
      l('done:results', results?.length);

      type Unprocessed = I extends BatchGetCommandInput
        ? Pick<BatchGetCommandInput, 'RequestItems'>
        : Pick<BatchWriteCommandInput, 'RequestItems'>;

      const errors: Array<Error | null> = [];
      const data: Array<SendAllResult<O> | null> = [];
      const unprocessed: Array<Unprocessed | null> = [];

      for (const res of results) {
        errors.push(res?.error ? ensureError(res.error) : null);
        data.push(res?.data ? (res.data as SendAllResult<O>) : null);

        if (!res?.data) {
          unprocessed.push(null);
          continue;
        }

        if (
          'UnprocessedItems' in res.data &&
          res.data.UnprocessedItems &&
          Object.keys(res.data.UnprocessedItems).length
        ) {
          unprocessed.push({
            RequestItems: res.data.UnprocessedItems,
          } as Unprocessed);
        } else if (
          'UnprocessedKeys' in res.data &&
          res.data.UnprocessedKeys &&
          Object.keys(res.data.UnprocessedKeys).length
        ) {
          unprocessed.push({
            RequestItems: res.data.UnprocessedKeys,
          } as Unprocessed);
        } else {
          unprocessed.push(null);
        }
      }

      if (options.compact === true) {
        (callback as SendAllCompactCallback<I>)(
          errors.filter((e) => Boolean(e)).length ? errors : undefined,
          compactSendAll(data),
          unprocessed.filter((u) => Boolean(u)).length ? load(unprocessed) : undefined,
        );
        return;
      }

      callback(
        errors.filter((e) => Boolean(e)).length ? errors : undefined,
        data,
        unprocessed.filter((u) => Boolean(u)).length ? load(unprocessed) : undefined,
      );
    };
  };

  const q = fastq(worker, concurrency);

  const results: Array<BatchResult | null> = [];

  q.drain = drain(results);

  for (const req of requests) {
    q.push(req, (_err, res) => {
      results.push(res ?? null);
    });
  }
}

function hasResponses<O extends BatchCommandOutput>(data: SendAllResult<O> | null) {
  if (!data) {
    return false;
  }

  if ('Responses' in data) {
    return true;
  }

  return false;
}

function hasUnprocessedKeys<O extends BatchCommandOutput>(data: SendAllResult<O> | null) {
  if (!data) {
    return false;
  }

  if ('UnprocessedKeys' in data) {
    return true;
  }

  return false;
}

function hasUnprocessedItems<O extends BatchCommandOutput>(data: SendAllResult<O> | null) {
  if (!data) {
    return false;
  }

  if ('UnprocessedItems' in data) {
    return true;
  }

  return false;
}

function compactSendAll<I extends BatchCommandInput, O extends BatchCommandOutput>(
  data: Array<SendAllResult<O> | null>,
) {
  if (data.some(hasResponses)) {
    for (const d of data) {
      if (d) {
        const responses = (d as SendAllResult<BatchGetCommandOutput>).Responses;
        (d as SendAllCompactGetOutput).Responses = responses
          ? Object.values(responses)[0]
          : responses;
      }
    }
  }

  if (data.some(hasUnprocessedKeys)) {
    for (const d of data) {
      if (d) {
        const unprocessed = (d as SendAllResult<BatchGetCommandOutput>).UnprocessedKeys;
        (d as SendAllCompactGetOutput).UnprocessedKeys = unprocessed
          ? Object.values(unprocessed)[0]
          : unprocessed;
      }
    }
  }

  if (data.some(hasUnprocessedItems)) {
    for (const d of data) {
      if (d) {
        const unprocessed = (d as SendAllResult<BatchWriteCommandOutput>).UnprocessedItems;
        (d as SendAllCompactWriteOutput).UnprocessedItems = unprocessed
          ? Object.values(unprocessed)[0]
          : unprocessed;
      }
    }
  }

  return data as Array<SendAllCompactResult<I> | null>;
}

async function _sendAllAsync<
  I extends BatchCommandInput,
  O extends BatchCommandOutput = I extends BatchGetCommandInput
    ? BatchGetCommandOutput
    : BatchWriteCommandOutput,
>(
  requests: Array<Fetcher<I> | null>,
  load: SendAllBatch<I>['load'],
  options: SendAllOptions & CompactOptions,
) {
  return new Promise<{
    error: Array<Error | null> | undefined;
    data: Array<SendAllResult<O> | SendAllCompactResult<I> | null>;
    unprocessed?: SendAllBatch<I>;
  }>((resolve) => {
    _sendAll<I>(requests, load, options, (error, data, unprocessed) => {
      resolve({ error, data, unprocessed });
    });
  });
}

export class SendAllBatch<
  I extends BatchCommandInput,
  O extends BatchCommandOutput = I extends BatchGetCommandInput
    ? BatchGetCommandOutput
    : BatchWriteCommandOutput,
> {
  public readonly requests: Array<Fetcher<I> | null>;

  constructor(
    private readonly requestFactory: RequestFactory<I>,
    items: Array<Pick<I, 'RequestItems' | 'ReturnConsumedCapacity'> | null>,
    private readonly options: SendAllOptions,
  ) {
    this.requests = items.map((params) => (params ? requestFactory(params as I) : null));
  }

  load(items: Array<Pick<I, 'RequestItems' | 'ReturnConsumedCapacity'> | null>) {
    return new SendAllBatch<I>(this.requestFactory, items, this.options);
  }

  sendAll(options: SendAllOptions & { compact: true }): Promise<{
    error: Array<Error | null> | undefined;
    data: Array<SendAllCompactResult<I> | null>;
    unprocessed?: SendAllBatch<I>;
  }>;
  sendAll(options?: SendAllOptions): Promise<{
    error: Array<Error | null> | undefined;
    data: Array<SendAllResult<O> | null>;
    unprocessed?: SendAllBatch<I>;
  }>;
  sendAll(cb: SendAllCallback<I>): void;
  sendAll(options: SendAllOptions, cb: SendAllCallback<I>): void;
  sendAll(options: SendAllOptions & { compact: true }, cb: SendAllCompactCallback<I>): void;

  sendAll(
    optionsOrCb?: SendAllCallback<I> | SendAllCompactCallback<I> | SendAllOptions,
    cb?: SendAllCallback<I> | SendAllCompactCallback<I>,
    // biome-ignore lint/suspicious/noConfusingVoidType: callback-or-promise overload returns void in the callback path
  ): void | Promise<{
    error: Array<Error | null> | undefined;
    data: Array<SendAllResult<O> | SendAllCompactResult<I> | null>;
    unprocessed?: SendAllBatch<I>;
  }> {
    if (typeof optionsOrCb === 'function') {
      _sendAll<I>(this.requests, this.load.bind(this), this.options, optionsOrCb);
    } else if (typeof cb === 'function') {
      _sendAll<I>(this.requests, this.load.bind(this), { ...this.options, ...optionsOrCb }, cb);
    } else {
      return _sendAllAsync<I, O>(this.requests, this.load.bind(this), {
        ...this.options,
        ...optionsOrCb,
      });
    }
  }
}
