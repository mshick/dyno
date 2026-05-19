import { TextEncoder } from 'node:util';
import {
  type AttributeValue,
  type Capacity,
  type ConsumedCapacity,
  type CreateTableCommandInput,
  type GlobalSecondaryIndexDescription,
  type GlobalSecondaryIndexUpdate,
  KeyType,
  type TableDescription,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import Big from 'big.js';
import cloneDeep from 'lodash/cloneDeep.js';
import difference from 'lodash/difference.js';
import intersection from 'lodash/intersection.js';
import isEqual from 'lodash/isEqual.js';
import isEqualWith from 'lodash/isEqualWith.js';
import isPlainObject from 'lodash/isPlainObject.js';
import pick from 'lodash/pick.js';
import type { NativeAttributeMap } from './types.ts';

export function calculateDelay(
  retryCount: number,
  retryBase = 250,
  jitterBase = 1000,
  maxDelay = 20000,
) {
  const backoff = retryBase * 2 ** Math.max(0, retryCount);
  const jitter = Math.random() * jitterBase;
  return Math.round(Math.min(maxDelay, backoff + jitter));
}

type KeyOfAttributeValue = keyof AttributeValue;

const stringSize = (val: string) => {
  // Account for size of utf-8 encoded chars in strings, emoji, etc
  return new TextEncoder().encode(val).length;
};

const bufferSize = (val: Uint8Array) => {
  return Buffer.from(val).toString('base64').length;
};

const bigNumberSize = (val: string) => {
  const v = new Big(val);
  return Math.ceil(v.c.length / 2) + (v.e % 2 ? 1 : 2);
};

/**
 * Calculate the size in bytes of a DynamoDB record.
 */
export function itemSize(item: Record<string, AttributeValue>) {
  let size = 0;

  const valueSize = (attrVal: AttributeValue) => {
    const type = Object.keys(attrVal)[0] as KeyOfAttributeValue;
    const val = attrVal[type];

    let vSize = 0;

    switch (type) {
      case 'S':
        vSize += stringSize(val as string);
        break;
      case 'B':
        vSize += bufferSize(val as Uint8Array);
        break;
      case 'N':
        vSize += bigNumberSize(val as string);
        break;
      case 'SS':
        vSize += (val as string[]).reduce((sum, v) => sum + stringSize(v), 0);
        break;
      case 'BS':
        vSize += (val as Uint8Array[]).reduce((sum, v) => sum + bufferSize(v), 0);
        break;
      case 'NS':
        vSize += (val as string[]).reduce((sum, v) => sum + bigNumberSize(v), 0);
        break;
      case 'M':
        vSize += itemSize(val as Record<string, AttributeValue>);
        break;
      case 'L':
        vSize += (val as AttributeValue[]).reduce((sum, v) => sum + valueSize(v), 0);
        break;
      case 'BOOL':
        // Best guess, this is the string length of the boolean
        vSize += (val as boolean) ? 4 : 5;
        break;
      case 'NULL':
        // String length of null?
        vSize += 4;
        break;
      default:
        break;
    }

    return vSize;
  };

  for (const [attributeName, attributeValue] of Object.entries(item)) {
    size += attributeName.length;
    size += valueSize(attributeValue);
  }

  return size;
}

export function getItemSize(item: NativeAttributeMap) {
  return itemSize(marshall(item, { removeUndefinedValues: true }));
}

export function readCost(item: NativeAttributeMap) {
  const size = getItemSize(item);
  return Math.ceil(size / 1024 / 4);
}

export function writeCost(item: NativeAttributeMap) {
  const size = getItemSize(item);
  return Math.ceil(size / 1024);
}

export function storageCost(item: NativeAttributeMap) {
  const size = getItemSize(item);
  return size + 100;
}

export const delay = async <T>(timeout: number, value?: T): Promise<T> =>
  new Promise<T>((resolve): void => {
    setTimeout(resolve, timeout, value as T);
  });

/**
 * Reduce two sets of consumed capacity metrics into a single object
 * This should be in sync with Callback Parameters section of
 * https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB/DocumentClient.html#query-property
 */
export function reduceCapacity(
  existing: ConsumedCapacity,
  incoming: ConsumedCapacity[] | ConsumedCapacity,
) {
  let target = cloneDeep(existing);

  if (Array.isArray(incoming)) {
    for (const item of incoming) {
      target = reduceCapacity(target, item);
    }

    return target;
  }

  const mergeCapacityUnits = (dst: Capacity, src: Capacity) => {
    if (src.CapacityUnits) {
      dst.CapacityUnits = (dst.CapacityUnits ?? 0) + src.CapacityUnits;
    }

    if (src.ReadCapacityUnits) {
      dst.ReadCapacityUnits = (dst.ReadCapacityUnits ?? 0) + src.ReadCapacityUnits;
    }

    if (src.WriteCapacityUnits) {
      dst.WriteCapacityUnits = (dst.WriteCapacityUnits ?? 0) + src.WriteCapacityUnits;
    }
  };

  const mergeCapacityParents = (
    dst: Record<string, Capacity>,
    src: Record<string, Capacity>,
    k: string,
  ) => {
    const s = src[k];
    const d = dst[k] ?? {};

    if (!s) {
      return;
    }

    dst[k] = d;

    mergeCapacityUnits(d, s);
  };

  target.Table ??= target.Table ?? {};
  target.TableName ??= incoming.TableName;

  mergeCapacityUnits(target, incoming);
  mergeCapacityUnits(target.Table, incoming.Table ?? {});

  for (const indexGroup of ['LocalSecondaryIndexes', 'GlobalSecondaryIndexes'] as const) {
    const dst = target[indexGroup] ?? {};
    const src = incoming[indexGroup] ?? {};

    for (const index of Object.keys(src)) {
      mergeCapacityParents(dst, src, index);
    }

    target[indexGroup] = dst;
  }

  return target;
}

/**
 * Get the partition key from a table description
 */
export function getPartitionKey(tableDescription: TableDescription) {
  const hashKey = tableDescription.KeySchema?.find(
    (el) => el.KeyType === KeyType.HASH,
  )?.AttributeName;
  const rangeKey = tableDescription.KeySchema?.find(
    (el) => el.KeyType === KeyType.RANGE,
  )?.AttributeName;

  if (!hashKey && !rangeKey) {
    return;
  }

  return {
    hashKey,
    rangeKey,
    keyName: [hashKey, rangeKey].filter((x) => x).join('_'),
  };
}

/**
 * Turn unknown objects into Errors
 */
export function ensureError(err: unknown, msg = 'Unknown error'): Error {
  if (err instanceof Error) {
    return err;
  }

  let message = msg;

  if (err && typeof err === 'object') {
    message = typeof (err as Error).message === 'string' ? (err as Error).message : message;
  }

  return new Error(message, { cause: err });
}

function isRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value);
}

const pickGSIKeys = (gsi: GlobalSecondaryIndexDescription) =>
  pick(gsi, ['IndexName', 'KeySchema', 'Projection']);
const pickGSIList = (gsiList?: GlobalSecondaryIndexDescription[]) =>
  gsiList?.map(pickGSIKeys) ?? null;

const arrayObjectSortKeys = ['AttributeName', 'IndexName'];

const arraySorter = (a: unknown, b: unknown) => {
  if (typeof a === 'string' && typeof b === 'string') {
    return a.localeCompare(b);
  }

  if (isRecord(a) && isRecord(b)) {
    for (const key of arrayObjectSortKeys) {
      const aa = a[key];
      const bb = b[key];
      if (aa && bb) {
        return aa.localeCompare(bb);
      }
    }
  }

  throw new Error('Unexpected config, could not determine if index migration is needed');
};

const equalWith = (a: unknown, b: unknown) => {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }

    const aSorted = a.sort(arraySorter);
    const bSorted = b.sort(arraySorter);

    for (let i = 0; i < aSorted.length; i++) {
      if (!isEqualWith(aSorted[i], bSorted[i], equalWith)) {
        return false;
      }
    }

    return true;
  }

  return undefined;
};

export function isEqualGSI(
  a?: GlobalSecondaryIndexDescription[],
  b?: GlobalSecondaryIndexDescription[],
) {
  return isEqualWith(pickGSIList(a), pickGSIList(b), equalWith);
}

function isDefined<T>(x: T | null | undefined): x is T {
  return x !== null && x !== undefined;
}

function getChangedIndexes(
  oldIndexList: GlobalSecondaryIndexDescription[],
  newIndexList: GlobalSecondaryIndexDescription[],
) {
  const oldIndexes = oldIndexList.map(({ IndexName }) => IndexName) ?? [];
  const newIndexes = newIndexList.map(({ IndexName }) => IndexName);

  const added = difference(newIndexes, oldIndexes).filter(isDefined);
  const removed = difference(oldIndexes, newIndexes).filter(isDefined);

  let updated = intersection(oldIndexes, newIndexes).filter(isDefined);

  if (updated.length) {
    updated = updated.filter((indexName) => {
      const oldIndex = oldIndexList.find(({ IndexName }) => IndexName === indexName);
      const newIndex = newIndexList.find(({ IndexName }) => IndexName === indexName);

      if (!oldIndex && !newIndex) {
        return false;
      }

      return !isEqual(
        oldIndex ? pickGSIKeys(oldIndex) : undefined,
        newIndex ? pickGSIKeys(newIndex) : undefined,
      );
    });
  }

  return {
    added,
    removed,
    updated,
  };
}

export function getIndexUpdates(
  oldTable: TableDescription,
  newTable: CreateTableCommandInput,
): GlobalSecondaryIndexUpdate[] | undefined {
  const oldIndexList = oldTable.GlobalSecondaryIndexes ?? [];
  const newIndexList = newTable.GlobalSecondaryIndexes ?? [];

  const { added, removed, updated } = getChangedIndexes(oldIndexList, newIndexList);

  let indexUpdates: GlobalSecondaryIndexUpdate[] = [];

  if (updated.length) {
    const updates = updated.flatMap((indexName) => [
      {
        Delete: {
          IndexName: indexName,
        },
      },
      {
        Create: newTable.GlobalSecondaryIndexes?.find(({ IndexName }) => IndexName === indexName),
      },
    ]);

    indexUpdates = [...indexUpdates, ...updates];
  }

  if (removed.length) {
    const updates = removed.map((indexName) => ({
      Delete: {
        IndexName: indexName,
      },
    }));

    indexUpdates = [...indexUpdates, ...updates];
  }

  if (added.length) {
    const updates = added.map((indexName) => ({
      Create: newTable.GlobalSecondaryIndexes?.find(({ IndexName }) => IndexName === indexName),
    }));

    indexUpdates = [...indexUpdates, ...updates];
  }

  return indexUpdates.length ? indexUpdates : undefined;
}
