import type { ConsumedCapacity } from '@aws-sdk/client-dynamodb';
import type { BatchWriteCommandInput, BatchWriteCommandOutput } from '@aws-sdk/lib-dynamodb';
import { reduceCapacity } from '../util.ts';
import { ParallelWritable, type ParallelWritableOptions } from './parallel-writable.ts';

export type BatchWriteRequestItem = NonNullable<
  BatchWriteCommandInput['RequestItems']
>[string][number];
export type BatchWriteUnprocessedItem = NonNullable<
  BatchWriteCommandOutput['UnprocessedItems']
>[string][number];

export type DynoWritableStreamOptions = ParallelWritableOptions & {
  TableName: string;
};

export class DynoWritableStream extends ParallelWritable {
  Count = 0;
  UnprocessedItems: BatchWriteUnprocessedItem[] | undefined;
  ConsumedCapacity?: ConsumedCapacity;
  TableName: string;

  private readonly _consumedCapacity: ConsumedCapacity[] = [];

  constructor(opts: DynoWritableStreamOptions) {
    super(opts);
    this.TableName = opts.TableName;
  }

  update(response: BatchWriteCommandOutput | undefined, items: BatchWriteRequestItem[]) {
    const unprocessedItems = response?.UnprocessedItems?.[this.TableName];
    const unprocessedItemsLength = unprocessedItems?.length ?? 0;

    this.Count += items.length - unprocessedItemsLength;

    this.UnprocessedItems = unprocessedItems
      ? [...(this.UnprocessedItems ?? []), ...unprocessedItems]
      : this.UnprocessedItems;

    if (response?.ConsumedCapacity) {
      this._consumedCapacity.push(...response.ConsumedCapacity);
    }
  }

  done() {
    if (this._consumedCapacity.length) {
      this.ConsumedCapacity = reduceCapacity(this.ConsumedCapacity ?? {}, this._consumedCapacity);
    }
  }
}
