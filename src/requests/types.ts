import type { ConsumedCapacity } from '@aws-sdk/client-dynamodb';
import type {
  BatchGetCommandInput,
  BatchGetCommandOutput,
  BatchWriteCommandInput,
  BatchWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type { NativeAttributeMap } from '../types.ts';

export type BatchCommandInput = BatchGetCommandInput | BatchWriteCommandInput;
export type BatchCommandOutput = BatchGetCommandOutput | BatchWriteCommandOutput;

export type FetcherResponse<T extends BatchCommandOutput> =
  | {
      data: T;
      error?: undefined;
    }
  | {
      error: unknown;
      data?: undefined;
    };

export type Fetcher<T extends BatchCommandInput> = {
  params: T;
  send: () => Promise<
    FetcherResponse<
      T extends BatchGetCommandInput ? BatchGetCommandOutput : BatchWriteCommandOutput
    >
  >;
};

export type BatchResult = {
  error?: unknown;
  data: {
    Responses?: Record<string, Array<Record<string, any>>>;
    ConsumedCapacity?: ConsumedCapacity;
    UnprocessedKeys?: Record<string, { Keys: NativeAttributeMap[] }>;
    UnprocessedItems?: Record<string, NativeAttributeMap[]>;
  };
};

export type RequestFactory<U extends BatchCommandInput> = (params: U) => Fetcher<U>;

export type CompactOptions = {
  compact?: boolean;
};
