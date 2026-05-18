import { Readable, type ReadableOptions } from 'node:stream';
import type { ConsumedCapacity } from '@aws-sdk/client-dynamodb';
import type { QueryCommandOutput, ScanCommandOutput } from '@aws-sdk/lib-dynamodb';
import { reduceCapacity } from '../util.ts';

export type DynoReadableStreamOptions = {
  TableName: string;
  LastEvaluatedKey?: ScanCommandOutput['LastEvaluatedKey'];
  Limit?: number;
  Pages?: number;
};

export class DynoReadableStream extends Readable {
  Count = 0;
  ScannedCount = 0;
  LastEvaluatedKey: ScanCommandOutput['LastEvaluatedKey'];
  ConsumedCapacity?: ConsumedCapacity;
  Limit: number | undefined;
  Pages: number;
  TableName: string;

  private _updated = false;

  constructor(opts: ReadableOptions, dynoOpts: DynoReadableStreamOptions) {
    super(opts);

    this.TableName = dynoOpts.TableName;
    this.Limit = dynoOpts.Limit;
    this.Pages = dynoOpts.Pages ?? Number.POSITIVE_INFINITY;
    this.LastEvaluatedKey = dynoOpts.LastEvaluatedKey;
  }

  update(response?: ScanCommandOutput | QueryCommandOutput) {
    this.Count += response?.Count ?? 0;
    this.ScannedCount += response?.ScannedCount ?? 0;
    this.LastEvaluatedKey = response?.LastEvaluatedKey;
    this.ConsumedCapacity = response?.ConsumedCapacity
      ? reduceCapacity(this.ConsumedCapacity ?? {}, response.ConsumedCapacity)
      : this.ConsumedCapacity;
    this.Pages -= 1;
    this._updated = true;
  }

  hasNextPage() {
    return this._updated ? Boolean(this.LastEvaluatedKey) : true;
  }

  isLastPage() {
    return this._updated && (!this.LastEvaluatedKey || this.Pages <= 0);
  }

  getNextLimit() {
    if (this.Limit === undefined) {
      return;
    }

    return this.Limit - this.Count;
  }
}
