import { ReturnConsumedCapacity } from '@aws-sdk/client-dynamodb';
import {
  type BatchGetCommandInput,
  type BatchWriteCommandInput,
  DynamoDBDocument,
} from '@aws-sdk/lib-dynamodb';
import { faker } from '@faker-js/faker';
import { afterAll, afterEach, assert, beforeAll, describe, expect, test, vi } from 'vitest';
import { Dyno } from '../dyno.ts';
import {
  batchGetAll,
  batchGetItemRequests,
  batchWriteAll,
  batchWriteItemRequests,
} from '../requests/requests.ts';
import { createFixtures, getClient, getTestTableConfig } from './mocks.ts';

const hashTableName = 'idhash';

const client = getClient();
const dyno = Dyno.from(client);

afterEach(() => {
  vi.resetAllMocks();
});

afterAll(() => {
  dyno.destroy();
});

describe('requests', () => {
  describe.sequential('batchGetItemRequests', () => {
    const testTable = getTestTableConfig(hashTableName, 'batch-get-item-test');
    const tableName = testTable.TableName;
    const table = dyno.table(tableName);
    const fixtures = createFixtures({
      count: 150,
      data: { buffer: Buffer.from('my-buffer') },
    });

    beforeAll(async () => {
      await table.createTable(testTable);
      await table.batchPutAll(fixtures).sendAll();
    });

    afterAll(async () => {
      await table.deleteTable();
    });

    test('single table', async () => {
      const docClient = DynamoDBDocument.from(client);

      const params: BatchGetCommandInput = {
        RequestItems: {
          [tableName]: {
            Keys: fixtures.map(({ id }) => ({ id })),
          },
        },
      };

      const found = batchGetItemRequests(docClient, params);

      assert.equal(found.requests.length, 2, 'split 150 keys into two requests');

      const results = await Promise.all(found.requests.map(async (r) => r?.send()));

      const resultsCount = [
        ...(results[0]?.data?.Responses?.[tableName] ?? []),
        ...(results[1]?.data?.Responses?.[tableName] ?? []),
      ].length;
      assert.equal(resultsCount, 150, 'all responses were recieved');
      assert.isTrue(
        Buffer.isBuffer(results[0]?.data?.Responses?.[tableName]?.[0]?.buffer),
        'buffer is restored',
      );
    });

    test('single table - sendAll (callback)', async () => {
      const docClient = DynamoDBDocument.from(client);

      const params: BatchGetCommandInput = {
        RequestItems: {
          [tableName]: {
            Keys: fixtures.map(({ id }) => ({ id })),
          },
        },
      };

      const batch = batchGetItemRequests(docClient, params);

      assert.equal(batch.requests.length, 2, 'split 150 keys into two requests');

      batch.sendAll((err, results) => {
        assert.ifError(err, 'requests were sent successfully');
        const resultsCount = [
          ...(results[0]?.Responses?.[tableName] ?? []),
          ...(results[1]?.Responses?.[tableName] ?? []),
        ].length;
        assert.equal(resultsCount, 150, 'all responses were recieved');
      });

      batch.sendAll({ concurrency: 2 }, (err) => {
        assert.ifError(err, 'can set concurrency');
      });
    });

    test('single table - sendAll (promise)', async () => {
      const docClient = DynamoDBDocument.from(client);

      const params: BatchGetCommandInput = {
        RequestItems: {
          [tableName]: {
            Keys: fixtures.map(({ id }) => ({ id })),
          },
        },
      };

      const found = batchGetItemRequests(docClient, params);

      assert.equal(found.requests.length, 2, 'split 150 keys into two requests');

      const results = await found.sendAll();

      const resultsCount = [
        ...(results.data[0]?.Responses?.[tableName] ?? []),
        ...(results.data[1]?.Responses?.[tableName] ?? []),
      ].length;
      assert.equal(resultsCount, 150, 'all responses were recieved');
    });

    test('single table - sendAll (promise, compact)', async () => {
      const docClient = DynamoDBDocument.from(client);

      const params: BatchGetCommandInput = {
        RequestItems: {
          [tableName]: {
            Keys: fixtures.map(({ id }) => ({ id })),
          },
        },
      };

      const batch = batchGetItemRequests(docClient, params);

      assert.equal(batch.requests.length, 2, 'split 150 keys into two requests');

      const results = await batch.sendAll({ compact: true });

      const resultsCount = [
        ...(results.data[0]?.Responses ?? []),
        ...(results.data[1]?.Responses ?? []),
      ].length;
      assert.equal(resultsCount, 150, 'all responses were recieved');
    });

    test('with errors, unprocessed items present', async () => {
      const docClient = DynamoDBDocument.from(client);
      const batchGet = docClient.batchGet.bind(docClient);

      let onceError = true;
      let onceUnprocessed = true;
      let unprocessedItem: any;

      vi.spyOn(docClient, 'batchGet').mockImplementation(async (...args) => {
        if (onceError) {
          onceError = false;
          throw new Error('omg! mock error!');
        }

        const result = await batchGet(args[0], args[1]);
        const responses = result.Responses![tableName];

        let unprocessed: any;

        if (onceUnprocessed) {
          onceUnprocessed = false;
          unprocessed = responses!.shift();
          unprocessedItem = unprocessed;
        }

        return {
          ...result,
          Responses: {
            [tableName]: responses,
          },
          UnprocessedKeys: unprocessed
            ? {
                [tableName]: {
                  Keys: [{ id: unprocessed.id }],
                },
              }
            : {},
        };
      });

      const params: BatchGetCommandInput = {
        RequestItems: {
          [tableName]: {
            Keys: fixtures.map(({ id }) => ({ id })),
          },
        },
      };

      const found = batchGetItemRequests(docClient, params);
      const { error, data, unprocessed } = await found.sendAll();

      assert.equal(
        error?.length,
        found.requests.length,
        'when present, error array has as many entries as there were requests',
      );
      assert.equal(
        data.length,
        found.requests.length,
        'when present, data array has as many entries as there were responses',
      );
      assert.equal(
        unprocessed?.requests.length,
        found.requests.length,
        'when present, unprocessed array has as many entries as there were requests',
      );

      assert.equal(error?.[0]?.message, 'omg! mock error!', 'first request errored');
      assert.equal(data[0], null, 'response set to null when error occurred');
      assert.equal(unprocessed?.requests[0], null, 'first request contained no unprocessed items');

      const expected = {
        RequestItems: {
          [tableName]: {
            Keys: [{ id: unprocessedItem.id }],
          },
        },
      };

      assert.equal(error?.[1], null, 'no error on second request');
      assert.equal(data[1]?.Responses?.[tableName]?.length, 49, '49 successful requests');
      assert.deepEqual(
        unprocessed?.requests[1]?.params,
        expected,
        'unprocessed request for expected params',
      );
      assert.equal(
        typeof unprocessed?.sendAll,
        'function',
        'unprocessed response has bound .sendAll',
      );
    });
  });

  describe.sequential('batchWriteItemRequests', () => {
    const testTable = getTestTableConfig(hashTableName, 'batch-write-item-test');
    const tableName = testTable.TableName;
    const table = dyno.table(tableName);

    const fixtures = createFixtures({ count: 150 });

    beforeAll(async () => {
      await table.createTable(testTable);
      await table.batchPutAll(fixtures).sendAll();
    });

    afterAll(async () => {
      await table.deleteTable();
    });

    test('single table, small writes', async () => {
      const tableRequests: Array<Record<string, any>> = [];
      const putFixtures = createFixtures({ count: 45 });

      tableRequests.push(...putFixtures.map(({ id }) => ({ PutRequest: { Item: { id } } })));
      tableRequests.push(...fixtures.map(({ id }) => ({ DeleteRequest: { Key: { id } } })));

      const found = table.batchWriteItemRequests(tableRequests);

      assert.equal(found.requests.length, 8, 'split 150 deletes and 45 puts into 8 requests');

      const results = await Promise.all(found.requests.map(async (r) => r?.send()));

      for (const res of results) {
        expect(res).toMatchObject({ data: { UnprocessedItems: {} } });
      }

      const data = await table.scan({ Pages: Number.POSITIVE_INFINITY });
      assert.equal(data.Items?.length, 45, '150 items deleted, 45 written');
    });

    test('single table, large writes', async () => {
      const tableRequests: Array<Record<string, any>> = [];
      const putFixtures = createFixtures({
        count: 25,
        data: { data: faker.string.alphanumeric(690 * 1024) },
      });

      tableRequests.push(...putFixtures.map((Item) => ({ PutRequest: { Item } })));

      const found = table.batchWriteItemRequests(tableRequests);

      assert.equal(found.requests.length, 2, 'split 25 puts into 2 requests');

      // Do not send requests since they exceed 400k.
    });

    test('no errors, unprocessed items present', async () => {
      const docClient = DynamoDBDocument.from(client);
      const batchWrite = docClient.batchWrite.bind(docClient);

      let onceUnprocessed = true;
      let unprocessedItem: any;

      vi.spyOn(docClient, 'batchWrite').mockImplementation(async (...args) => {
        if (onceUnprocessed) {
          onceUnprocessed = false;
          const unprocessed = args[0].RequestItems![tableName]!.shift();
          unprocessedItem = unprocessed;
          const result = await batchWrite(args[0], args[1]);
          return {
            ...result,
            UnprocessedItems: {
              [tableName]: [unprocessed],
            },
          };
        }

        return batchWrite(args[0], args[1]);
      });

      const params: BatchWriteCommandInput = {
        RequestItems: {
          [tableName]: fixtures.map((Item) => ({ PutRequest: { Item } })),
        },
      };

      const batch = batchWriteItemRequests(docClient, params);
      const { data, error, unprocessed } = await batch.sendAll();

      assert.ifError(error, 'success');
      assert.equal(
        data.length,
        batch.requests.length,
        'when present, responses array has as many entries as there were requests',
      );
      assert.equal(
        unprocessed?.requests.length,
        batch.requests.length,
        'when present, unprocessed array has as many entries as there were requests',
      );

      const expected = {
        RequestItems: {
          [tableName]: [unprocessedItem],
        },
      };

      assert.deepEqual(
        unprocessed?.requests[0]?.params,
        expected,
        'unprocessed request for expected params',
      );

      assert.equal(unprocessed?.requests[1], null, 'second request contained no unprocessed items');
      assert.equal(unprocessed?.requests[2], null, 'third request contained no unprocessed items');
      assert.equal(unprocessed?.requests[3], null, 'fourth request contained no unprocessed items');
      assert.equal(unprocessed?.requests[4], null, 'fifth request contained no unprocessed items');
      assert.equal(unprocessed?.requests[5], null, 'fifth request contained no unprocessed items');

      assert.equal(
        typeof unprocessed?.sendAll,
        'function',
        'unprocessed response has bound .sendAll',
      );
    });

    test('with errors, unprocessed items present', async () => {
      const docClient = DynamoDBDocument.from(client);
      const batchWrite = docClient.batchWrite.bind(docClient);

      let onceUnprocessed = true;
      let onceError = true;
      let unprocessedItem: any;

      vi.spyOn(docClient, 'batchWrite').mockImplementation(async (...args) => {
        if (onceError) {
          onceError = false;
          throw new Error('omg! mock error!');
        }

        if (onceUnprocessed) {
          onceUnprocessed = false;
          const unprocessed = args[0].RequestItems![tableName]!.shift();
          unprocessedItem = unprocessed;
          const result = await batchWrite(args[0], args[1]);
          return {
            ...result,
            UnprocessedItems: {
              [tableName]: [unprocessed],
            },
          };
        }

        return batchWrite(args[0], args[1]);
      });

      const params: BatchWriteCommandInput = {
        RequestItems: {
          [tableName]: fixtures.map((Item) => ({ PutRequest: { Item } })),
        },
      };

      const batch = batchWriteItemRequests(docClient, params);
      const { data, error, unprocessed } = await batch.sendAll();

      assert.equal(
        error?.length,
        batch.requests.length,
        'when present, error array has as many entries as there were requests',
      );
      assert.equal(
        data.length,
        batch.requests.length,
        'when present, data array has as many entries as there were responses',
      );
      assert.equal(
        unprocessed?.requests.length,
        batch.requests.length,
        'when present, unprocessed array has as many entries as there were requests',
      );

      assert.equal(error?.[0]?.message, 'omg! mock error!', 'first request errored');
      assert.equal(data[0], null, 'response set to null when error occurred');
      assert.equal(unprocessed?.requests[0], null, 'first request contained no unprocessed items');

      const expected = {
        RequestItems: {
          [tableName]: [unprocessedItem],
        },
      };

      assert.equal(error?.[1], null, 'no error on second request');
      assert.equal(data[1]?.UnprocessedItems?.[tableName]?.length, 1, '1 unprocessed request');
      assert.deepEqual(
        unprocessed?.requests[1]?.params,
        expected,
        'unprocessed request for expected params',
      );

      assert.equal(error?.[2], null, 'no error on second request');
      assert.equal(Object.keys(data[2]?.UnprocessedItems ?? {}).length, 0, '0 unprocessed request');
      assert.deepEqual(unprocessed?.requests[2], null, 'no unprocessed requests');

      assert.equal(error?.[3], null, 'no error on second request');
      assert.equal(Object.keys(data[3]?.UnprocessedItems ?? {}).length, 0, '0 unprocessed request');
      assert.deepEqual(unprocessed?.requests[3], null, 'no unprocessed requests');

      assert.equal(error?.[4], null, 'no error on second request');
      assert.equal(Object.keys(data[4]?.UnprocessedItems ?? {}).length, 0, '0 unprocessed request');
      assert.deepEqual(unprocessed?.requests[4], null, 'no unprocessed requests');

      assert.equal(error?.[5], null, 'no error on second request');
      assert.equal(Object.keys(data[5]?.UnprocessedItems ?? {}).length, 0, '0 unprocessed request');
      assert.deepEqual(unprocessed?.requests[5], null, 'no unprocessed requests');

      assert.equal(
        typeof unprocessed?.sendAll,
        'function',
        'unprocessed response has bound .sendAll',
      );

      const { error: unprocessedError } = await unprocessed!.sendAll();
      assert.ifError(unprocessedError, 'successful .sendAll on unprocessed requestSet');
    });

    test('throws when a single item exceeds maxSize instead of looping forever', () => {
      const docClient = DynamoDBDocument.from(client);

      // maxSize=100 bytes; one item that obviously marshals larger than that
      const oversizeParams: BatchWriteCommandInput = {
        RequestItems: {
          [tableName]: [{ PutRequest: { Item: { id: 'big', blob: 'x'.repeat(1024) } } }],
        },
      };

      expect(() => batchWriteItemRequests(docClient, oversizeParams, { maxSize: 100 })).toThrow(
        /exceeds maxSize/i,
      );
    });
  });

  describe.sequential('batchGetAll', () => {
    const testTable = getTestTableConfig(hashTableName, 'batch-get-all-test');
    const tableName = testTable.TableName;
    const table = dyno.table(tableName);
    const fixtures = createFixtures({
      count: 150,
      data: { buffer: Buffer.from('my-buffer') },
    });

    beforeAll(async () => {
      await table.createTable(testTable);
      await table.batchPutAll(fixtures).sendAll();
    });

    afterAll(async () => {
      await table.deleteTable();
    });

    test('no errors, no unprocessed items', async () => {
      const docClient = DynamoDBDocument.from(client);
      const params: BatchGetCommandInput = {
        RequestItems: {
          [tableName]: {
            Keys: fixtures.map(({ id }) => ({ id })),
          },
        },
      };

      const batch = batchGetAll(docClient, params);
      const { data, error } = await batch.sendAll({ maxRetries: 1 });
      assert.ifError(error, 'requests were sent successfully');
      assert.isTrue(
        Buffer.isBuffer(data.Responses?.[tableName]?.[0]?.buffer),
        'buffer is restored',
      );
      assert.equal(data.Responses?.[tableName]?.length, 150, '150 successful responses');
    });

    test('no errors, unprocessed items', async () => {
      const docClient = DynamoDBDocument.from(client);
      const batchGet = docClient.batchGet.bind(docClient);

      vi.spyOn(docClient, 'batchGet').mockImplementation(async (...args) => {
        const result = await batchGet(args[0], args[1]);
        const responses = result.Responses![tableName];
        const unprocessed = responses!.shift();
        return {
          ...result,
          Responses: {
            [tableName]: responses,
          },
          UnprocessedKeys: unprocessed
            ? {
                [tableName]: {
                  Keys: [{ id: unprocessed.id }],
                },
              }
            : {},
        };
      });

      const params: BatchGetCommandInput = {
        RequestItems: {
          [tableName]: {
            Keys: fixtures.map(({ id }) => ({ id })),
          },
        },
      };

      const batch = batchGetAll(docClient, params);
      const { data, error } = await batch.sendAll({
        compact: true,
        maxRetries: 1,
      });
      assert.ifError(error, 'requests were sent successfully');
      assert.equal(
        data.Responses?.length,
        fixtures.length - 2,
        `${fixtures.length - 2} items requested successfully`,
      );
      assert.equal(data.UnprocessedKeys?.Keys?.length, 2, '2 unprocessed items');
    });

    test('no errors, unprocessed items - compact', async () => {
      const docClient = DynamoDBDocument.from(client);
      const batchGet = docClient.batchGet.bind(docClient);

      vi.spyOn(docClient, 'batchGet').mockImplementation(async (...args) => {
        const result = await batchGet(args[0], args[1]);
        const responses = result.Responses![tableName];
        const unprocessed = responses!.shift();
        return {
          ...result,
          Responses: {
            [tableName]: responses,
          },
          UnprocessedKeys: unprocessed
            ? {
                [tableName]: {
                  Keys: [{ id: unprocessed.id }],
                },
              }
            : {},
        };
      });

      const params: BatchGetCommandInput = {
        RequestItems: {
          [tableName]: {
            Keys: fixtures.map(({ id }) => ({ id })),
          },
        },
      };

      const batch = batchGetAll(docClient, params);
      const { data, error } = await batch.sendAll({ maxRetries: 1 });
      assert.ifError(error, 'requests were sent successfully');
      assert.equal(
        data.Responses?.[tableName]?.length,
        fixtures.length - 2,
        `${fixtures.length - 2} items requested successfully`,
      );
      assert.equal(data.UnprocessedKeys?.[tableName]?.Keys?.length, 2, '2 unprocessed items');
    });

    test('with errors, unprocessed items present', async () => {
      const docClient = DynamoDBDocument.from(client);
      const batchGet = docClient.batchGet.bind(docClient);

      let onceError = true;
      let onceUnprocessed = true;

      vi.spyOn(docClient, 'batchGet').mockImplementation(async (...args) => {
        if (onceError) {
          onceError = false;
          throw new Error('omg! mock error!');
        }

        const result = await batchGet(args[0], args[1]);
        const responses = result.Responses![tableName];
        let unprocessed: any;

        if (onceUnprocessed) {
          onceUnprocessed = false;
          unprocessed = responses!.shift();
        }

        return {
          ...result,
          Responses: {
            [tableName]: responses,
          },
          UnprocessedKeys: unprocessed
            ? {
                [tableName]: {
                  Keys: [{ id: unprocessed.id }],
                },
              }
            : {},
        };
      });

      const params: BatchGetCommandInput = {
        ReturnConsumedCapacity: ReturnConsumedCapacity.TOTAL,
        RequestItems: {
          [tableName]: {
            Keys: fixtures.map(({ id }) => ({ id })),
          },
        },
      };

      const batch = batchGetAll(docClient, params);
      const { data, error } = await batch.sendAll({ maxRetries: 0 });

      assert.equal(
        error?.message,
        'SendCompletely batch error',
        'single error was reported from a failed request',
      );
      assert.equal(
        data.Responses?.[tableName]?.length,
        fixtures.length - 101, // first batch lost, second one unprocessed
        `${fixtures.length - 101} successful responses (100 lost in error request, 1 unprocessed)`,
      );
      assert.equal(data.UnprocessedKeys?.[tableName]?.Keys?.length, 1, '1 unprocessed items');
      assert.deepEqual(
        data.ConsumedCapacity,
        {
          TableName: tableName,
          GlobalSecondaryIndexes: {},
          LocalSecondaryIndexes: {},
          Table: {},
          CapacityUnits: 50,
        },
        'aggregated consumed capacity from 2 requests',
      );
    });

    test('everything is unprocessed. timeout', async () => {
      const docClient = DynamoDBDocument.from(client);
      const batchGet = docClient.batchGet.bind(docClient);

      vi.spyOn(docClient, 'batchGet').mockImplementation(async (...args) => {
        const result = await batchGet(args[0], args[1]);
        const responses = result.Responses![tableName];

        return {
          ...result,
          Responses: {},
          UnprocessedKeys: {
            [tableName]: {
              Keys: responses?.map(({ id }) => ({ id })),
            },
          },
        };
      });

      const params: BatchGetCommandInput = {
        ReturnConsumedCapacity: ReturnConsumedCapacity.TOTAL,
        RequestItems: {
          [tableName]: {
            Keys: fixtures.map(({ id }) => ({ id })),
          },
        },
      };

      const batch = batchGetAll(docClient, params);
      const { data, error } = await batch.sendAll({ maxRetries: 0 });

      assert.ifError(error, 'there is no error here');
      assert.equal(data.Responses?.[tableName], undefined, 'there are no responses');
      assert.equal(
        data.UnprocessedKeys?.[tableName]?.Keys?.length,
        fixtures.length,
        'there are no responses',
      );
      assert.deepEqual(
        data.ConsumedCapacity,
        {
          TableName: tableName,
          GlobalSecondaryIndexes: {},
          LocalSecondaryIndexes: {},
          Table: {},
          CapacityUnits: 150,
        },
        'aggregated consumed capacity from 2 requests',
      );
    });
  });

  describe.sequential('batchWriteAll', () => {
    const testTable = getTestTableConfig(hashTableName, 'batch-write-all-test');
    const tableName = testTable.TableName;
    const table = dyno.table(tableName);
    const fixtures = createFixtures({ count: 150 });

    beforeAll(async () => {
      await table.createTable(testTable);
    });

    afterAll(async () => {
      await table.deleteTable();
    });

    afterEach(async () => {
      await table.batchDeleteAll(fixtures.map(({ id }) => ({ id }))).sendAll();
    });

    test('no errors, no unprocessed items', async () => {
      const docClient = DynamoDBDocument.from(client);
      const params: BatchWriteCommandInput = {
        RequestItems: {
          [tableName]: fixtures.map((Item) => ({ PutRequest: { Item } })),
        },
      };

      const batch = batchWriteAll(docClient, params);
      const { error } = await batch.sendAll();
      assert.ifError(error, 'requests were sent successfully');

      const data = await table.scan({ Pages: Number.POSITIVE_INFINITY });
      assert.equal(data.Items?.length, fixtures.length, '150 successful responses');
    });

    test('no errors, unprocessed items present - compact', async () => {
      const docClient = DynamoDBDocument.from(client);
      const batchWrite = docClient.batchWrite.bind(docClient);

      let onceUnprocessed = true;

      vi.spyOn(docClient, 'batchWrite').mockImplementation(async (...args) => {
        if (onceUnprocessed) {
          onceUnprocessed = false;
          const unprocessed = args[0].RequestItems![tableName]!.shift();
          const result = await batchWrite(args[0], args[1]);
          return {
            ...result,
            UnprocessedItems: {
              [tableName]: [unprocessed],
            },
          };
        }

        return batchWrite(args[0], args[1]);
      });

      const params: BatchWriteCommandInput = {
        RequestItems: {
          [tableName]: fixtures.map((Item) => ({ PutRequest: { Item } })),
        },
      };

      const batch = batchWriteAll(docClient, params);
      const { data, error } = await batch.sendAll({
        compact: true,
        maxRetries: 0,
      });

      assert.ifError(error, 'requests were sent successfully');

      assert.equal(data.UnprocessedItems?.length, 1, '1 unprocessed items');

      const scan = await table.scan({ Pages: Number.POSITIVE_INFINITY });
      assert.equal(scan.Items?.length, fixtures.length - 1, '149 successful responses');
    });

    test('with errors, unprocessed items present', async () => {
      const docClient = DynamoDBDocument.from(client);
      const batchWrite = docClient.batchWrite.bind(docClient);

      let onceError = true;
      let onceUnprocessed = true;

      vi.spyOn(docClient, 'batchWrite').mockImplementation(async (...args) => {
        if (onceError) {
          onceError = false;
          throw new Error('omg! mock error!');
        }

        if (onceUnprocessed) {
          onceUnprocessed = false;
          const unprocessed = args[0].RequestItems![tableName]!.shift();
          const result = await batchWrite(args[0], args[1]);
          return {
            ...result,
            UnprocessedItems: {
              [tableName]: [unprocessed],
            },
          };
        }

        return batchWrite(args[0], args[1]);
      });

      const params: BatchWriteCommandInput = {
        ReturnConsumedCapacity: ReturnConsumedCapacity.TOTAL,
        RequestItems: {
          [tableName]: fixtures.map((Item) => ({ PutRequest: { Item } })),
        },
      };

      const batch = batchWriteAll(docClient, params);
      const { data, error } = await batch.sendAll({ maxRetries: 0 });

      assert.equal(
        error?.message,
        'SendCompletely batch error',
        'single error was reported from a failed request',
      );
      assert.equal(data.UnprocessedItems?.[tableName]?.length, 1, '1 unprocessed items');
      assert.deepEqual(
        data.ConsumedCapacity,
        {
          TableName: tableName,
          GlobalSecondaryIndexes: {},
          LocalSecondaryIndexes: {},
          Table: {},
          CapacityUnits: 744,
        },
        'aggregated consumed capacity from 2 requests',
      );
    });
  });
});
