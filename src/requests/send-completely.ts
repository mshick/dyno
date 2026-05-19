import type { ConsumedCapacity } from '@aws-sdk/client-dynamodb';
import type {
  BatchGetCommandInput,
  BatchGetCommandOutput,
  BatchWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import createDebug from 'debug';
import fastq, { type worker as QueueWorker } from 'fastq';
import { calculateDelay, delay, ensureError, reduceCapacity } from '../util.ts';
import type {
  BatchCommandInput,
  BatchCommandOutput,
  BatchResult,
  CompactOptions,
  Fetcher,
  RequestFactory,
} from './types.ts';

const log = createDebug('dyno-requests');

type SendCompletelyCallback<
  I extends BatchCommandInput,
  O extends BatchCommandOutput = I extends BatchGetCommandInput
    ? BatchGetCommandOutput
    : BatchWriteCommandOutput,
> = (error: AggregateError | undefined, data: SendCompletelyResult<O>) => void;

type SendCompletelyCompactCallback<I extends BatchCommandInput> = (
  error: AggregateError | undefined,
  data: SendCompletelyCompactResult<I>,
) => void;

export type SendCompletelyResult<O extends BatchCommandOutput> = Omit<
  O,
  '$metadata' | 'ConsumedCapacity'
> & {
  ConsumedCapacity?: ConsumedCapacity;
};

export type SendCompletelyGetOutput = SendCompletelyResult<BatchGetCommandOutput>;
export type SendCompletelyWriteOutput = SendCompletelyResult<BatchWriteCommandOutput>;
export type SendCompletelyCompactGetOutput = Omit<
  SendCompletelyResult<BatchGetCommandOutput>,
  'Responses' | 'UnprocessedKeys'
> & {
  Responses?: NonNullable<BatchGetCommandOutput['Responses']>[string];
  UnprocessedKeys?: NonNullable<BatchGetCommandOutput['UnprocessedKeys']>[string];
  ConsumedCapacity?: ConsumedCapacity;
};

export type SendCompletelyCompactWriteOutput = Omit<
  SendCompletelyResult<BatchWriteCommandOutput>,
  'UnprocessedItems'
> & {
  UnprocessedItems?: NonNullable<BatchWriteCommandOutput['UnprocessedItems']>[string];
  ConsumedCapacity?: ConsumedCapacity;
};

export type SendCompletelyCompactResult<I extends BatchCommandInput> =
  I extends BatchGetCommandInput
    ? SendCompletelyCompactGetOutput
    : SendCompletelyCompactWriteOutput;

export type SendCompletelyOptions = {
  concurrency?: number;
  maxRetries?: number;
};

/**
 * Compacts results, removing the often redundant table name key
 */
function compactSendCompletely<I extends BatchCommandInput, O extends BatchCommandOutput>(
  data: SendCompletelyResult<O>,
) {
  if ('Responses' in data) {
    const responses = (data as SendCompletelyResult<BatchGetCommandOutput>).Responses;
    (data as SendCompletelyCompactGetOutput).Responses = responses
      ? Object.values(responses)[0]
      : responses;
  }

  if ('UnprocessedKeys' in data) {
    const unprocessed = (data as SendCompletelyResult<BatchGetCommandOutput>).UnprocessedKeys;
    (data as SendCompletelyCompactGetOutput).UnprocessedKeys = unprocessed
      ? Object.values(unprocessed)[0]
      : unprocessed;
  }

  if ('UnprocessedItems' in data) {
    const unprocessed = (data as SendCompletelyResult<BatchWriteCommandOutput>).UnprocessedItems;
    (data as SendCompletelyCompactWriteOutput).UnprocessedItems = unprocessed
      ? Object.values(unprocessed)[0]
      : unprocessed;
  }

  return data as SendCompletelyCompactResult<I>;
}

/**
 * Given a set of requests, this function sends them all at specified concurrency,
 * retrying any unprocessed items until every request has either succeeded or failed.
 * The responses from the set of requests are aggregated into a single response.
 * Generally, this function is not called directly, but is bound to an array of
 * requests with the first two parameters wired to specific values.
 */
function _sendCompletely<I extends BatchCommandInput>(
  requests: Array<Fetcher<I>>,
  requestFactory: RequestFactory<I>,
  options: SendCompletelyOptions & { compact: true },
  callback: SendCompletelyCompactCallback<I>,
): void;
function _sendCompletely<I extends BatchCommandInput>(
  requests: Array<Fetcher<I>>,
  requestFactory: RequestFactory<I>,
  options: SendCompletelyOptions,
  callback: SendCompletelyCallback<I>,
): void;
function _sendCompletely<
  I extends BatchCommandInput,
  O extends BatchCommandOutput = I extends BatchGetCommandInput
    ? BatchGetCommandOutput
    : BatchWriteCommandOutput,
>(
  requests: Array<Fetcher<I>>,
  requestFactory: RequestFactory<I>,
  options: SendCompletelyOptions & CompactOptions,
  callback: SendCompletelyCallback<I> | SendCompletelyCompactCallback<I>,
) {
  const l = log.extend('sendCompletely');

  const { concurrency = 1, maxRetries = 5 } = options;

  l('requests:', requests.length, 'concurrency:', concurrency, 'maxRetries:', maxRetries);

  const worker: QueueWorker<unknown, Fetcher<I>, BatchResult> = (request, done) => {
    const result: BatchResult = { error: null, data: {} };

    let retryCount = 0;

    const send = async (req: Fetcher<I>): Promise<BatchResult> => {
      const res = await req.send();

      if (!res.data) {
        l('send:error', res.error);
        result.error = res.error;
        return result;
      }

      if ('Responses' in res.data) {
        if (res.data.Responses) {
          result.data.Responses ??= {};
          const responses = result.data.Responses;
          for (const [table, item] of Object.entries(res.data.Responses)) {
            responses[table] ??= [];
            const bucket = responses[table];
            for (const r of item) {
              bucket.push(r);
            }
          }
        }
      }

      if (res.data.ConsumedCapacity) {
        result.data.ConsumedCapacity = reduceCapacity(
          result.data.ConsumedCapacity ?? {},
          res.data.ConsumedCapacity,
        );
      }

      let retry: Fetcher<I> | undefined;

      if ('UnprocessedItems' in res.data) {
        if (res.data.UnprocessedItems && Object.keys(res.data.UnprocessedItems).length) {
          retry = requestFactory({
            RequestItems: res.data.UnprocessedItems,
            ReturnConsumedCapacity: req.params.ReturnConsumedCapacity,
          } as I);
        }
      }

      if ('UnprocessedKeys' in res.data) {
        if (res.data.UnprocessedKeys && Object.keys(res.data.UnprocessedKeys).length) {
          retry = requestFactory({
            RequestItems: res.data.UnprocessedKeys,
            ReturnConsumedCapacity: req.params.ReturnConsumedCapacity,
          } as I);
        }
      }

      if (retry && retryCount < maxRetries) {
        l('send:retry', retryCount);
        await delay(calculateDelay(retryCount));
        retryCount += 1;
        return send(retry);
      }

      if ('UnprocessedKeys' in res.data) {
        if (res.data.UnprocessedKeys) {
          result.data.UnprocessedKeys ??= {};
          const unprocessedKeys = result.data.UnprocessedKeys;
          for (const [table, item] of Object.entries(res.data.UnprocessedKeys)) {
            unprocessedKeys[table] ??= { Keys: [] };
            const bucket = unprocessedKeys[table];
            bucket.Keys ??= [];
            for (const r of item.Keys ?? []) {
              bucket.Keys.push(r);
            }
          }
        }
      }

      if ('UnprocessedItems' in res.data) {
        if (res.data.UnprocessedItems) {
          result.data.UnprocessedItems ??= {};
          const unprocessedItems = result.data.UnprocessedItems;
          for (const [table, items] of Object.entries(res.data.UnprocessedItems)) {
            unprocessedItems[table] ??= [];
            const bucket = unprocessedItems[table];
            for (const r of items) {
              bucket.push(r);
            }
          }
        }
      }

      return result;
    };

    void send(request)
      .then((res) => {
        done(null, res);
      })
      .catch((err: unknown) => {
        result.error = ensureError(err);
        done(null, result);
      });
  };

  const drain = (results: BatchResult[]) => {
    return () => {
      l('drain:results', results.length);

      const errors: unknown[] = [];
      const data: Partial<
        SendCompletelyResult<BatchGetCommandOutput> & SendCompletelyResult<BatchWriteCommandOutput>
      > = {};

      if (results.length) {
        for (const res of results) {
          if (res.error) {
            errors.push(res.error);
          }

          if (!res.data) {
            continue;
          }

          if ('Responses' in res.data) {
            if (res.data.Responses) {
              data.Responses ??= {};
              const responses = data.Responses;
              for (const [table, response] of Object.entries(res.data.Responses)) {
                responses[table] ??= [];
                const bucket = responses[table];
                for (const r of response) {
                  bucket.push(r);
                }
              }
            }
          }

          if ('UnprocessedItems' in res.data) {
            if (res.data.UnprocessedItems && Object.keys(res.data.UnprocessedItems ?? {}).length) {
              data.UnprocessedItems ??= {};
              const unprocessedItems = data.UnprocessedItems;
              for (const [table, items] of Object.entries(res.data.UnprocessedItems)) {
                unprocessedItems[table] ??= [];
                const bucket = unprocessedItems[table];
                for (const r of items) {
                  bucket.push(r);
                }
              }
            }
          }

          if ('UnprocessedKeys' in res.data) {
            if (res.data.UnprocessedKeys && Object.keys(res.data.UnprocessedKeys ?? {}).length) {
              data.UnprocessedKeys ??= {};
              const unprocessedKeys = data.UnprocessedKeys;
              for (const [table, items] of Object.entries(res.data.UnprocessedKeys)) {
                unprocessedKeys[table] ??= { Keys: [] };
                const bucket = unprocessedKeys[table];
                bucket.Keys ??= [];
                for (const r of items.Keys ?? []) {
                  bucket.Keys.push(r);
                }
              }
            }
          }

          if (res.data.ConsumedCapacity) {
            data.ConsumedCapacity = reduceCapacity(
              data.ConsumedCapacity ?? {},
              res.data.ConsumedCapacity,
            );
          }
        }
      }

      if (options.compact === true) {
        (callback as SendCompletelyCompactCallback<I>)(
          errors.length ? new AggregateError(errors, 'SendCompletely batch error') : undefined,
          compactSendCompletely<I, O>(data as SendCompletelyResult<O>),
        );
        return;
      }

      callback(
        errors.length ? new AggregateError(errors, 'SendCompletely batch error') : undefined,
        data as SendCompletelyResult<O>,
      );
    };
  };

  const q = fastq(worker, concurrency);

  const results: BatchResult[] = [];

  q.drain = drain(results);

  for (const req of requests) {
    q.push(req, (_err, res) => {
      if (res) {
        results.push(res);
      }
    });
  }
}

async function _sendCompletelyAsync<I extends BatchCommandInput, O extends BatchCommandOutput>(
  requests: Array<Fetcher<I>>,
  requestFactory: RequestFactory<I>,
  options: SendCompletelyOptions & CompactOptions,
) {
  return new Promise<{
    data: SendCompletelyResult<O> | SendCompletelyCompactResult<I>;
    error: AggregateError | undefined;
  }>((resolve) => {
    _sendCompletely<I>(requests, requestFactory, options, (error, data) => {
      resolve({ error, data });
    });
  });
}

export class SendCompletelyBatch<
  I extends BatchCommandInput,
  O extends BatchCommandOutput = I extends BatchGetCommandInput
    ? BatchGetCommandOutput
    : BatchWriteCommandOutput,
> {
  public readonly requests: Array<Fetcher<I>>;

  constructor(
    private readonly requestFactory: RequestFactory<I>,
    public items: Array<Pick<I, 'RequestItems' | 'ReturnConsumedCapacity'>>,
    private readonly options: SendCompletelyOptions,
  ) {
    this.requests = items.map((params) => requestFactory(params as I));
  }

  load(items: Array<Pick<I, 'RequestItems' | 'ReturnConsumedCapacity'>>) {
    return new SendCompletelyBatch<I>(this.requestFactory, items, this.options);
  }

  sendAll(options: SendCompletelyOptions & { compact: true }): Promise<{
    data: SendCompletelyCompactResult<I>;
    error: AggregateError | undefined;
  }>;
  sendAll(options?: SendCompletelyOptions): Promise<{
    data: SendCompletelyResult<O>;
    error: AggregateError | undefined;
  }>;
  sendAll(cb: SendCompletelyCallback<I>): void;
  sendAll(options: SendCompletelyOptions, cb: SendCompletelyCallback<I>): void;
  sendAll(
    options: SendCompletelyOptions & { compact: true },
    cb: SendCompletelyCompactCallback<I>,
  ): void;

  sendAll(
    optionsOrCb?:
      | SendCompletelyCallback<I>
      | SendCompletelyCompactCallback<I>
      | (SendCompletelyOptions & CompactOptions),
    cb?: SendCompletelyCallback<I> | SendCompletelyCompactCallback<I>,
    // biome-ignore lint/suspicious/noConfusingVoidType: callback-or-promise overload returns void in the callback path
  ): void | Promise<{
    data: SendCompletelyResult<O> | SendCompletelyCompactResult<I>;
    error: AggregateError | undefined;
  }> {
    if (typeof optionsOrCb === 'function') {
      _sendCompletely(this.requests, this.requestFactory, this.options, optionsOrCb);
    } else if (typeof cb === 'function') {
      _sendCompletely(this.requests, this.requestFactory, { ...this.options, ...optionsOrCb }, cb);
    } else {
      return _sendCompletelyAsync<I, O>(this.requests, this.requestFactory, {
        ...this.options,
        ...optionsOrCb,
      });
    }
  }
}
