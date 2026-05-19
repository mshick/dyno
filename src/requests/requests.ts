import type {
  BatchGetCommandInput,
  BatchWriteCommandInput,
  DynamoDBDocument,
} from '@aws-sdk/lib-dynamodb';
import type { HttpHandlerOptions } from '@smithy/types';
import createDebug from 'debug';
import { type ParseResponseOptions, parseResponse } from '../responses.ts';
import type { NativeAttributeMap } from '../types.ts';
import { getItemSize } from '../util.ts';
import { SendAllBatch, type SendAllOptions } from './send-all.ts';
import { SendCompletelyBatch, type SendCompletelyOptions } from './send-completely.ts';

const log = createDebug('dyno-requests');

function _batchGetItemRequests(params: BatchGetCommandInput): BatchGetCommandInput[] {
  const requestItems = params.RequestItems;
  if (!requestItems) {
    throw new Error('RequestItems is required');
  }

  const batchedItems = Object.keys(requestItems).reduce<BatchGetCommandInput[]>(
    (paramSet, tableName) => {
      const keys = requestItems[tableName]?.Keys;
      if (!keys) {
        return paramSet;
      }

      const toMake = [...keys];

      return chop(toMake);

      function chop(requestsToMake: Array<Record<string, unknown>>) {
        // request set that we're building — paramSet is seeded with one entry
        // and only grows, so paramSet[paramSet.length - 1] is always defined.
        const lastParams = paramSet[paramSet.length - 1];
        if (!lastParams) {
          return paramSet;
        }
        const requests = lastParams.RequestItems ?? {};
        const requestsTable = requests[tableName] ?? { Keys: [] };

        requests[tableName] = requestsTable;

        // count existing requests in the current params
        const count = Object.keys(requests).reduce((count, tableName) => {
          return count + (requests[tableName]?.Keys?.length ?? 0);
        }, 0);

        // gather more from the requested params
        const more = requestsToMake.splice(0, 100 - count);

        // add them to the request set
        requestsTable.Keys = (requestsTable.Keys ?? []).concat(more);

        // if there are no requests left, return the modified paramSet
        if (!requestsToMake.length) {
          return paramSet;
        }

        // otherwise start a new request set
        paramSet.push({
          RequestItems: {},
          ReturnConsumedCapacity: params.ReturnConsumedCapacity,
        });

        return chop(requestsToMake);
      }
    },
    [
      {
        RequestItems: {},
        ReturnConsumedCapacity: params.ReturnConsumedCapacity,
      },
    ],
  );

  return batchedItems;
}

export type BatchWriteItemRequestsOptions = {
  maxLength?: number;
  maxSize?: number;
};

function _batchWriteItemRequests(
  params: BatchWriteCommandInput,
  { maxLength = 25, maxSize = 16 * 1024 * 1024 }: BatchWriteItemRequestsOptions = {},
): BatchWriteCommandInput[] {
  const requestItems = params.RequestItems;
  if (!requestItems) {
    throw new Error('RequestItems is required');
  }

  const batchedItems = Object.keys(requestItems).reduce<BatchWriteCommandInput[]>(
    (paramSet, tableName) => {
      const reqs = requestItems[tableName];

      if (!reqs) {
        return paramSet;
      }

      return chop([...reqs]);

      function chop(requestsToMake: NonNullable<BatchWriteCommandInput['RequestItems']>[string]) {
        // paramSet is seeded with one entry and only grows.
        const lastParams = paramSet[paramSet.length - 1];
        if (!lastParams) {
          return paramSet;
        }
        const requests = lastParams.RequestItems ?? {};
        const requestsTable = requests[tableName] ?? [];

        requests[tableName] = requestsTable;

        // count existing requests in the current params
        const count = Object.values(requests).reduce((c, r) => {
          return c + r.length;
        }, 0);

        // find existing requests size
        let size = Object.values(requests).reduce((s, request) => {
          return (
            s +
            request.reduce((s, r) => {
              return s + (r.PutRequest?.Item ? getItemSize(r.PutRequest.Item) : 0);
            }, 0)
          );
        }, 0);

        // Add requests one by one until it would put us over the size limit
        const startingCount = count;
        for (let i = 0; i < maxLength - count; i++) {
          const next = requestsToMake[0];
          if (!next) {
            return paramSet;
          }

          const nextSize = next.PutRequest?.Item ? getItemSize(next.PutRequest.Item) : 0;

          if (size + nextSize > maxSize) {
            break;
          }

          size += nextSize;

          const itemToPush = requestsToMake.shift();
          if (itemToPush) {
            requestsTable.push(itemToPush);
          }
        }

        // if there are no requests left, return the modified paramSet
        if (!requestsToMake.length) {
          return paramSet;
        }

        // If the next item couldn't fit in an empty params set, it's larger than
        // maxSize on its own — recursing would loop forever.
        if (startingCount === 0 && requestsTable.length === 0) {
          const next = requestsToMake[0];
          const nextSize = next?.PutRequest?.Item ? getItemSize(next.PutRequest.Item) : 0;
          throw new Error(`Item exceeds maxSize: item is ~${nextSize} bytes, limit is ${maxSize}`);
        }

        // otherwise start a new request set
        paramSet.push({
          RequestItems: {},
          ReturnConsumedCapacity: params.ReturnConsumedCapacity,
        });

        return chop(requestsToMake);
      }
    },
    [
      {
        RequestItems: {},
        ReturnConsumedCapacity: params.ReturnConsumedCapacity,
      },
    ],
  );

  return batchedItems;
}

export function batchWriteItemRequests(
  client: DynamoDBDocument,
  params: BatchWriteCommandInput,
  options: HttpHandlerOptions & BatchWriteItemRequestsOptions & SendAllOptions = {},
) {
  const l = log.extend('batchWriteItemRequests');

  l(params, options);

  const requestFactory = (params: BatchWriteCommandInput) => ({
    params,
    async send() {
      try {
        const data = await client.batchWrite(params, options);
        return { data };
      } catch (error) {
        return { error };
      }
    },
  });

  const items = _batchWriteItemRequests(params, options);

  return new SendAllBatch<BatchWriteCommandInput>(requestFactory, items, options);
}

export function batchGetItemRequests(
  client: DynamoDBDocument,
  params: BatchGetCommandInput,
  options: HttpHandlerOptions & SendAllOptions & ParseResponseOptions = {},
) {
  const l = log.extend('batchGetItemRequests');

  l(params, options);

  const requestFactory = (params: BatchGetCommandInput) => ({
    params,
    async send() {
      try {
        const data = parseResponse(await client.batchGet(params, options), options);
        return { data };
      } catch (error) {
        return { error };
      }
    },
  });

  const items = _batchGetItemRequests(params);

  return new SendAllBatch<BatchGetCommandInput>(requestFactory, items, options);
}

export function batchWriteAll(
  client: DynamoDBDocument,
  params: BatchWriteCommandInput,
  options: HttpHandlerOptions & SendCompletelyOptions = {},
) {
  const l = log.extend('batchWriteAll');

  l(params, options);

  const requestFactory = (params: BatchWriteCommandInput) => ({
    params,
    async send() {
      try {
        const data = await client.batchWrite(params, options);
        return { data };
      } catch (error) {
        return { error };
      }
    },
  });

  const items = _batchWriteItemRequests(params);

  return new SendCompletelyBatch<BatchWriteCommandInput>(requestFactory, items, options);
}

export function batchPutAll(
  client: DynamoDBDocument,
  tableName: string,
  items: NativeAttributeMap[],
  options: HttpHandlerOptions & SendCompletelyOptions = {},
) {
  const params: BatchWriteCommandInput = {
    RequestItems: {
      [tableName]: items.map((item) => ({
        PutRequest: {
          Item: item,
        },
      })),
    },
  };

  return batchWriteAll(client, params, options);
}

export function batchDeleteAll(
  client: DynamoDBDocument,
  tableName: string,
  items: NativeAttributeMap[],
  options: HttpHandlerOptions & SendCompletelyOptions = {},
) {
  const params: BatchWriteCommandInput = {
    RequestItems: {
      [tableName]: items.map((item) => ({
        DeleteRequest: {
          Key: item,
        },
      })),
    },
  };

  return batchWriteAll(client, params, options);
}

export function batchGetAll(
  client: DynamoDBDocument,
  params: BatchGetCommandInput,
  options: HttpHandlerOptions & SendCompletelyOptions & ParseResponseOptions = {},
) {
  const l = log.extend('batchGetAll');

  l(params, options);

  const requestFactory = (params: BatchGetCommandInput) => ({
    params,
    async send() {
      try {
        const data = parseResponse(await client.batchGet(params, options), options);
        return { data };
      } catch (error) {
        return { error };
      }
    },
  });

  const items = _batchGetItemRequests(params);

  return new SendCompletelyBatch<BatchGetCommandInput>(requestFactory, items, options);
}
