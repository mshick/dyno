import type { ConsumedCapacity, GlobalSecondaryIndexDescription } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { faker } from '@faker-js/faker';
import cloneDeep from 'lodash/cloneDeep.js';
import { afterAll, assert, beforeAll, describe, expect, test } from 'vitest';
import { Dyno } from '../dyno.ts';
import {
  ensureError,
  getPartitionKey,
  isEqualGSI,
  itemSize,
  readCost,
  reduceCapacity,
  writeCost,
} from '../util.ts';
import { getClient, getTestTableConfig } from './mocks.ts';

const dyno = Dyno.from(getClient());

afterAll(() => {
  dyno.destroy();
});

describe('reduceCapacity', () => {
  test('parses new data format correctly', () => {
    const src: ConsumedCapacity[] = [
      {
        TableName: 'db-staging',
        CapacityUnits: 8,
        ReadCapacityUnits: 3,
        WriteCapacityUnits: 1,
        Table: {
          CapacityUnits: 4,
          ReadCapacityUnits: 3,
          WriteCapacityUnits: 1,
        },
        GlobalSecondaryIndexes: {
          'id-index': {
            CapacityUnits: 4,
          },
        },
      },
    ];

    const dst: Partial<ConsumedCapacity> = {};

    const res = reduceCapacity(dst, src);

    assert.equal(res.CapacityUnits, 8);
    assert.equal(res.Table?.CapacityUnits, 4);
    assert.equal(res.GlobalSecondaryIndexes?.['id-index']?.CapacityUnits, 4);
  });
});

describe('itemSize', () => {
  test('calculates the size of a simple item', () => {
    const item = {
      aString: 'FOO',
      aNumber: 12345,
      aBigNumber: '12345904820598345098340593845092831394023048234',
      aBool: true,
      aNull: null,
    };

    const size = itemSize(marshall(item));

    expect(size).toEqual(97);
  });

  test('calculates the size of a simple item - false adds a byte', () => {
    const item = {
      aString: 'FOO',
      aNumber: 12345,
      aBigNumber: '12345904820598345098340593845092831394023048234',
      aBool: false,
      aNull: null,
    };

    const size = itemSize(marshall(item));

    expect(size).toEqual(98);
  });

  test('calculates overhead for props', () => {
    const buffer = Buffer.alloc(1024 * 50);

    const bufferLength = buffer.toString('base64').length;

    const item = {
      buffer,
    };

    const size = itemSize(marshall(item));

    expect(size).toEqual(bufferLength + 'buffer'.length);
  });

  test('calculates the size of a complex oversized item', () => {
    const megaByte = Buffer.alloc(1024 * 400);

    const item = {
      aString: 'powerPumpkins✊🎃',
      aNumber: 12345,
      aBigNumber: '12345904820598345098340593845092831394023048234',
      aStringArr: ['foo', 'bar', 'baz'],
      aNumberArr: [1029, 349, 52],
      aBuffer: megaByte,
    };

    const size = itemSize(marshall(item));

    expect(size).toEqual(546277);
  });

  test('calculates the size of a items with nested objects', () => {
    const nestedObject = { foo: 'FOO' };

    const item = {
      title: 'Hello World',
      nestedObject,
    };

    const size = itemSize(marshall(item));

    expect(size).toEqual(34);
  });

  test('calculates the size of a items with nested object arrays', () => {
    const nestedObject = { foo: 'FOO' };

    const item = {
      title: 'Hello World',
      nestedObjectArr: [nestedObject],
    };

    const size = itemSize(marshall(item));

    expect(size).toEqual(37);
  });

  test('calculates the size of a string set', () => {
    const set = new Set(['a', 'b']);

    const item = {
      title: 'Hello World',
      set,
    };

    const size = itemSize(marshall(item));

    expect(size).toEqual(21);
  });

  test('calculates the size of a number set', () => {
    const set = new Set([1, 2]);

    const item = {
      title: 'Hello World',
      set,
    };

    const size = itemSize(marshall(item));

    expect(size).toEqual(25);
  });

  test('calculates the size of a buffer set', () => {
    const buffer = Buffer.alloc(1024 * 50);
    const set = new Set([buffer]);

    const bufferLength = buffer.toString('base64').length;

    const item = {
      set,
    };

    const size = itemSize(marshall(item));

    expect(size).toEqual(bufferLength + 'set'.length);
  });

  test('unknown case - just the attr name', () => {
    // @ts-expect-error
    const size = itemSize({ UNKNOWN: 123 });

    expect(size).toEqual('UNKNOWN'.length);
  });

  test('readCost', () => {
    const item = {
      id: 'FOO',
      data: faker.string.alphanumeric(5 * 1024),
    };

    expect(readCost(item)).toEqual(2);
  });

  test('writeCost', () => {
    const item = {
      id: 'FOO',
      data: faker.string.alphanumeric(5 * 1024),
    };

    expect(writeCost(item)).toEqual(6);
  });

  test('storageCost', () => {
    const item = {
      id: 'FOO',
      data: faker.string.alphanumeric(5 * 1024),
    };
    expect(writeCost(item)).toEqual(6);
  });
});

describe('getPartitionKey', () => {
  const hashTableConfig = getTestTableConfig('idhash', 'partition-key-hash-test');
  const hashRangeTableConfig = getTestTableConfig(
    'idhash-numrange',
    'partition-key-hashrange-test',
  );

  const hashTable = dyno.table(hashTableConfig.TableName);
  const hashRangeTable = dyno.table(hashRangeTableConfig.TableName);

  beforeAll(async () => {
    await dyno.createTable(hashTableConfig);
    await dyno.createTable(hashRangeTableConfig);
  });

  afterAll(async () => {
    await dyno.deleteTable(hashTableConfig);
    await dyno.deleteTable(hashRangeTableConfig);
  });

  test('hash-only table', async () => {
    const existing = await hashTable.describeTable();

    expect(existing.Table).toBeDefined();

    const res = getPartitionKey(existing.Table);

    expect(res).toEqual({ hashKey: 'id', keyName: 'id' });
  });

  test('hash-range table', async () => {
    const existing = await hashRangeTable.describeTable();

    expect(existing.Table).toBeDefined();

    const res = getPartitionKey(existing.Table);

    expect(res).toEqual({ hashKey: 'id', rangeKey: 'num', keyName: 'id_num' });
  });
});

describe('isEqualGSI', () => {
  const indexListA: GlobalSecondaryIndexDescription[] = [
    {
      IndexName: 'byProjectId',
      KeySchema: [
        {
          AttributeName: 'email',
          KeyType: 'RANGE',
        },
        {
          AttributeName: 'projectId',
          KeyType: 'HASH',
        },
      ],
      Projection: {
        ProjectionType: 'ALL',
      },
      IndexStatus: 'ACTIVE',
      ProvisionedThroughput: {
        NumberOfDecreasesToday: 0,
        ReadCapacityUnits: 0,
        WriteCapacityUnits: 0,
      },
      IndexSizeBytes: 15102,
      ItemCount: 96,
      IndexArn:
        'arn:aws:dynamodb:us-east-1:590044319366:table/takeshape.dev.pr3869.email-invites/index/byProjectId',
    },
    {
      IndexName: 'byEmail',
      KeySchema: [
        {
          AttributeName: 'email',
          KeyType: 'HASH',
        },
        {
          AttributeName: 'projectId',
          KeyType: 'RANGE',
        },
      ],
      Projection: {
        ProjectionType: 'ALL',
      },
      IndexStatus: 'ACTIVE',
      ProvisionedThroughput: {
        NumberOfDecreasesToday: 0,
        ReadCapacityUnits: 0,
        WriteCapacityUnits: 0,
      },
      IndexSizeBytes: 15102,
      ItemCount: 96,
      IndexArn:
        'arn:aws:dynamodb:us-east-1:590044319366:table/takeshape.dev.pr3869.email-invites/index/byEmail',
    },
  ];

  const indexListB: GlobalSecondaryIndexDescription[] = [
    {
      IndexName: 'byEmail',
      KeySchema: [
        {
          AttributeName: 'email',
          KeyType: 'HASH',
        },
        {
          AttributeName: 'projectId',
          KeyType: 'RANGE',
        },
      ],
      Projection: {
        ProjectionType: 'ALL',
      },
    },
    {
      IndexName: 'byProjectId',
      KeySchema: [
        {
          AttributeName: 'projectId',
          KeyType: 'HASH',
        },
        {
          AttributeName: 'email',
          KeyType: 'RANGE',
        },
      ],
      Projection: {
        ProjectionType: 'ALL',
      },
    },
  ];

  test('same', () => {
    expect(isEqualGSI(indexListA, indexListB)).toEqual(true);
  });

  test('modified - IndexName', () => {
    const modified = cloneDeep(indexListB);
    modified[0]!.IndexName = 'somethingSoRandom';

    expect(isEqualGSI(indexListA, modified)).toEqual(false);
  });

  test('modified - KeySchema', () => {
    const modified = cloneDeep(indexListB);
    modified[0]!.KeySchema![0]!.AttributeName = 'foo';

    expect(isEqualGSI(indexListA, modified)).toEqual(false);
  });

  test('modified - Projection', () => {
    const modified = cloneDeep(indexListB);
    modified[0]!.Projection!.NonKeyAttributes = ['foo'];
    expect(isEqualGSI(indexListA, modified)).toEqual(false);
  });

  test('fails build on unexpected config instead of guessing if it should do a migration or not', () => {
    expect(() =>
      isEqualGSI(
        [
          {
            KeySchema: 'value1',
          },
          {
            KeySchema: 'value2',
          },
        ] as any,
        [
          {
            KeySchema: 'value2',
          },
          {
            KeySchema: 'value1',
          },
        ] as any,
      ),
    ).toThrowError('Unexpected config, could not determine if index migration is needed');
  });
});

describe('ensureError', () => {
  test('a non-error object', () => {
    const obj = { foo: 'FOO' };
    const err = ensureError(obj);
    expect(err.message).toEqual('Unknown error');
    expect(err.cause).toEqual(obj);
  });

  test('a non-error object with a message', () => {
    const obj = { message: 'FOO' };
    const err = ensureError(obj);
    expect(err.message).toEqual('FOO');
    expect(err.cause).toEqual(obj);
  });

  test('an error', () => {
    const obj = new Error('foo');
    const err = ensureError(obj);
    expect(err.message).toEqual('foo');
    expect(err.cause).toBeUndefined();
  });
});
