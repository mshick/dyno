import {
  IndexStatus,
  ResourceNotFoundException,
  type StreamSpecification,
} from '@aws-sdk/client-dynamodb';
import { afterAll, afterEach, assert, beforeAll, describe, expect, test, vi } from 'vitest';
import { Dyno } from '../dyno.ts';
import {
  createTable,
  ensureTable,
  killConnection,
  waitForConnection,
  waitForIndex,
} from '../table.ts';
import type { EnsureTableInput } from '../types.ts';
import { getClient, getTestTableConfig, getTestTableName } from './mocks.ts';

const testTable = getTestTableConfig('idhash', 'test-table');
const tableName = testTable.TableName;
const client = getClient();
const dyno = Dyno.from(client);

beforeAll(async () => {
  await dyno.createTable(testTable);
});

afterEach(() => {
  vi.resetAllMocks();
});

afterAll(async () => {
  await dyno.deleteTable({ TableName: tableName });
  dyno.destroy();
});

describe('table', () => {
  describe('waitForConnection', () => {
    test('resolves immediately when connection is available', async () => {
      const mockClient = getClient();
      const listTablesSpy = vi.spyOn(mockClient, 'listTables');

      await waitForConnection(mockClient);

      expect(listTablesSpy).toHaveBeenCalledOnce();
    });

    test('retries when connection initially fails', async () => {
      const mockClient = getClient();
      const listTablesSpy = vi.spyOn(mockClient, 'listTables');

      // First call fails, second succeeds
      listTablesSpy.mockRejectedValueOnce(new Error('Connection failed'));

      await waitForConnection(mockClient);

      expect(listTablesSpy).toHaveBeenCalledTimes(2);
    });

    test('retries multiple times before succeeding', async () => {
      const mockClient = getClient();
      const listTablesSpy = vi.spyOn(mockClient, 'listTables');

      // Fail 3 times, then succeed
      listTablesSpy
        .mockRejectedValueOnce(new Error('Connection failed'))
        .mockRejectedValueOnce(new Error('Connection failed'))
        .mockRejectedValueOnce(new Error('Connection failed'));

      await waitForConnection(mockClient);

      expect(listTablesSpy).toHaveBeenCalledTimes(4);
    });

    test('does not throw errors from failed connection attempts', async () => {
      const mockClient = getClient();
      const listTablesSpy = vi.spyOn(mockClient, 'listTables');

      // Fail once with an error, then succeed
      listTablesSpy.mockRejectedValueOnce(new Error('Network error'));

      await expect(waitForConnection(mockClient)).resolves.toBeUndefined();
    });

    describe('stabilizeDelay option', () => {
      test('waits for custom stabilizeDelay after successful connection', async () => {
        const mockClient = getClient();
        const stabilizeDelay = 1000;
        const startTime = Date.now();

        await waitForConnection(mockClient, { stabilizeDelay });

        const elapsed = Date.now() - startTime;
        // Should wait at least the stabilizeDelay (allow some margin for test execution)
        expect(elapsed).toBeGreaterThanOrEqual(stabilizeDelay - 50);
      });

      test('uses default stabilizeDelay of 500ms when not specified', async () => {
        const mockClient = getClient();
        const startTime = Date.now();

        await waitForConnection(mockClient);

        const elapsed = Date.now() - startTime;
        // Should wait at least the default 500ms (allow some margin for test execution)
        expect(elapsed).toBeGreaterThanOrEqual(450);
      });

      test('waits for stabilizeDelay even after retries', async () => {
        const mockClient = getClient();
        const listTablesSpy = vi.spyOn(mockClient, 'listTables');
        const stabilizeDelay = 800;

        // Fail twice, then succeed
        listTablesSpy
          .mockRejectedValueOnce(new Error('Connection failed'))
          .mockRejectedValueOnce(new Error('Connection failed'));

        const startTime = Date.now();
        await waitForConnection(mockClient, { stabilizeDelay });
        const elapsed = Date.now() - startTime;

        // Should wait for retries (2 * 100ms) + stabilizeDelay (800ms)
        // Total should be at least 1000ms (allow margin)
        expect(elapsed).toBeGreaterThanOrEqual(950);
        expect(listTablesSpy).toHaveBeenCalledTimes(3);
      });

      test('can set stabilizeDelay to 0 for no delay', async () => {
        const mockClient = getClient();
        const startTime = Date.now();

        await waitForConnection(mockClient, { stabilizeDelay: 0 });

        const elapsed = Date.now() - startTime;
        // Should complete quickly with no stabilize delay (allow some margin for execution)
        expect(elapsed).toBeLessThan(100);
      });
    });

    describe('maxDelay option', () => {
      test('throws error when maxDelay is exceeded', async () => {
        const mockClient = getClient();
        const listTablesSpy = vi.spyOn(mockClient, 'listTables');

        // Mock to always fail
        listTablesSpy.mockRejectedValue(new Error('Connection failed'));

        const maxDelay = 500;
        await expect(waitForConnection(mockClient, { maxDelay })).rejects.toThrow(
          'Max connection attempts reached',
        );

        // With attemptDelay of 100ms and maxDelay of 500ms, maxAttempts = 5
        expect(listTablesSpy).toHaveBeenCalledTimes(5);
      });

      test('uses default maxDelay of 5000ms when not specified', async () => {
        const mockClient = getClient();
        const listTablesSpy = vi.spyOn(mockClient, 'listTables');

        // Mock to always fail
        listTablesSpy.mockRejectedValue(new Error('Connection failed'));

        const startTime = Date.now();
        await expect(waitForConnection(mockClient)).rejects.toThrow(
          'Max connection attempts reached',
        );
        const elapsed = Date.now() - startTime;

        // With attemptDelay of 100ms and maxDelay of 5000ms, maxAttempts = 50
        // Should take approximately 5000ms (allow margin)
        expect(listTablesSpy).toHaveBeenCalledTimes(50);
        expect(elapsed).toBeGreaterThanOrEqual(4900);
        expect(elapsed).toBeLessThan(6000);
      });

      test('succeeds before maxDelay is reached', async () => {
        const mockClient = getClient();
        const listTablesSpy = vi.spyOn(mockClient, 'listTables');

        // Fail 3 times, then succeed (total time: 300ms, well under maxDelay)
        listTablesSpy
          .mockRejectedValueOnce(new Error('Connection failed'))
          .mockRejectedValueOnce(new Error('Connection failed'))
          .mockRejectedValueOnce(new Error('Connection failed'));

        const maxDelay = 1000;
        await expect(waitForConnection(mockClient, { maxDelay })).resolves.toBeUndefined();

        expect(listTablesSpy).toHaveBeenCalledTimes(4);
      });

      test('handles small maxDelay values correctly', async () => {
        const mockClient = getClient();
        const listTablesSpy = vi.spyOn(mockClient, 'listTables');

        // Mock to always fail
        listTablesSpy.mockRejectedValue(new Error('Connection failed'));

        const maxDelay = 250;
        await expect(waitForConnection(mockClient, { maxDelay })).rejects.toThrow(
          'Max connection attempts reached',
        );

        // With attemptDelay of 100ms and maxDelay of 250ms, maxAttempts = 2
        expect(listTablesSpy).toHaveBeenCalledTimes(2);
      });

      test('maxDelay of 0 disables timeout', async () => {
        const mockClient = getClient();
        const listTablesSpy = vi.spyOn(mockClient, 'listTables');

        // Fail many times, then succeed
        for (let i = 0; i < 100; i++) {
          listTablesSpy.mockRejectedValueOnce(new Error('Connection failed'));
        }

        const maxDelay = 0;
        await expect(waitForConnection(mockClient, { maxDelay })).resolves.toBeUndefined();

        // Should succeed after 101 attempts without timing out
        expect(listTablesSpy).toHaveBeenCalledTimes(101);
      });
    });

    describe('combined stabilizeDelay and maxDelay options', () => {
      test('applies both options correctly', async () => {
        const mockClient = getClient();
        const listTablesSpy = vi.spyOn(mockClient, 'listTables');

        // Fail once, then succeed
        listTablesSpy.mockRejectedValueOnce(new Error('Connection failed'));

        const stabilizeDelay = 600;
        const maxDelay = 2000;
        const startTime = Date.now();

        await waitForConnection(mockClient, { stabilizeDelay, maxDelay });

        const elapsed = Date.now() - startTime;
        // Should wait for retry (100ms) + stabilizeDelay (600ms) = 700ms minimum
        expect(elapsed).toBeGreaterThanOrEqual(650);
        expect(listTablesSpy).toHaveBeenCalledTimes(2);
      });

      test('throws when maxDelay is reached even with custom stabilizeDelay', async () => {
        const mockClient = getClient();
        const listTablesSpy = vi.spyOn(mockClient, 'listTables');

        // Mock to always fail
        listTablesSpy.mockRejectedValue(new Error('Connection failed'));

        const stabilizeDelay = 1000; // This won't be reached
        const maxDelay = 300;

        await expect(waitForConnection(mockClient, { stabilizeDelay, maxDelay })).rejects.toThrow(
          'Max connection attempts reached',
        );

        // With attemptDelay of 100ms and maxDelay of 300ms, maxAttempts = 3
        expect(listTablesSpy).toHaveBeenCalledTimes(3);
      });
    });
  });

  describe('killConnection', () => {
    test('calls destroy on the client', () => {
      const mockClient = getClient();
      const destroySpy = vi.spyOn(mockClient, 'destroy');

      killConnection(mockClient);

      expect(destroySpy).toHaveBeenCalledOnce();
    });

    test('returns void', () => {
      const mockClient = getClient();
      const result = killConnection(mockClient);

      expect(result).toBeUndefined();
    });
  });

  test('create table no-op when already exists', async () => {
    const existing = await dyno.describeTable(testTable);
    assert.equal(existing.Table?.TableName, testTable.TableName, 'table already exists');

    const data = await dyno.createTable(testTable);
    assert.ok(data.TableDescription, 'response contains TableDescription');

    const after = await dyno.describeTable(testTable);
    assert.equal(after.Table?.TableName, testTable.TableName, 'table still exists');
  });

  test('create table that does not exist', async () => {
    const tableConfig = getTestTableConfig('idhash', 'new-table');
    const { TableName } = tableConfig;

    const data = await dyno.createTable(tableConfig);
    assert.ok(data.TableDescription, 'response contains TableDescription');

    const table = await dyno.describeTable({ TableName });
    assert.equal(table.Table?.TableName, TableName, 'table still exists');
  });

  test('delete table that does exist', async () => {
    const TableName = 'delete-me';

    await dyno.createTable({ ...testTable, TableName });

    const data = await dyno.deleteTable({ TableName });
    assert.notOk(data, 'no data returned');

    try {
      await dyno.describeTable({ TableName });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof ResourceNotFoundException, 'deletes a table');
    }
  });

  test('delete table no-op on table that does not exist', async () => {
    const TableName = 'dne';

    const data = await dyno.deleteTable({ TableName });
    assert.notOk(data, 'no data returned');
  });

  describe.sequential('ensureTable', () => {
    const tableWithHashKeyName = getTestTableName('test-table1');
    const tableWithHashKey = (TableName: string): EnsureTableInput => ({
      TableName,
      AttributeDefinitions: [
        {
          AttributeName: 'id',
          AttributeType: 'S',
        },
        {
          AttributeName: 'version',
          AttributeType: 'N',
        },
      ],
      KeySchema: [
        {
          AttributeName: 'id',
          KeyType: 'HASH',
        },
        {
          AttributeName: 'version',
          KeyType: 'RANGE',
        },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    });

    const tableWithHashRangeKeyName = getTestTableName('test-table2');
    const tableWithHashRangeKey: EnsureTableInput = {
      TableName: tableWithHashRangeKeyName,
      AttributeDefinitions: [
        {
          AttributeName: 'id',
          AttributeType: 'S',
        },
        {
          AttributeName: 'version',
          AttributeType: 'N',
        },
      ],
      KeySchema: [
        {
          AttributeName: 'id',
          KeyType: 'HASH',
        },
        {
          AttributeName: 'version',
          KeyType: 'RANGE',
        },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    };

    const tableWithHashKey2Name = getTestTableName('test-table3');
    const tableWithHashKey2: EnsureTableInput = {
      TableName: tableWithHashKey2Name,
      AttributeDefinitions: [
        {
          AttributeName: 'id',
          AttributeType: 'S',
        },
      ],
      KeySchema: [
        {
          AttributeName: 'id',
          KeyType: 'HASH',
        },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    };

    beforeAll(async () => {
      await Promise.all([
        ensureTable(client, tableWithHashKey(tableWithHashKeyName)),
        ensureTable(client, tableWithHashRangeKey),
      ]);
    });

    test('simultaneous invocations', async () => {
      try {
        await Promise.all([
          ensureTable(client, tableWithHashKey2),
          ensureTable(client, tableWithHashKey2),
        ]);
      } catch {
        assert.fail('ensureTable should handle multiple simultaneous invocations');
      }
    });

    test('update stream spec', async () => {
      const table: EnsureTableInput = {
        TableName: getTestTableName('ensure-stream-spec-test'),
        AttributeDefinitions: [
          {
            AttributeName: 'id',
            AttributeType: 'S',
          },
        ],
        KeySchema: [
          {
            AttributeName: 'id',
            KeyType: 'HASH',
          },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      };

      await ensureTable(client, table);

      const streamSpec: StreamSpecification = {
        StreamEnabled: true,
        StreamViewType: 'NEW_IMAGE',
      };

      const actual = await ensureTable(client, {
        ...table,
        StreamSpecification: streamSpec,
      });
      expect(actual.TableDescription).toMatchObject({
        StreamSpecification: streamSpec,
      });
    });

    test('update an index', async () => {
      const TableName = getTestTableName('update-index-spec-test');
      const InitialIndexName = 'bySecondaryId';
      const firstTable: EnsureTableInput = {
        TableName,
        AttributeDefinitions: [
          {
            AttributeName: 'id',
            AttributeType: 'S',
          },
          {
            AttributeName: 'secondaryId',
            AttributeType: 'S',
          },
        ],
        KeySchema: [
          {
            AttributeName: 'id',
            KeyType: 'HASH',
          },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: InitialIndexName,
            KeySchema: [
              {
                AttributeName: 'secondaryId',
                KeyType: 'HASH',
              },
            ],
            Projection: {
              ProjectionType: 'KEYS_ONLY',
            },
          },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      };

      await ensureTable(client, firstTable);

      await waitForIndex(client, { TableName, IndexName: InitialIndexName }, IndexStatus.CREATING);

      const secondTable: EnsureTableInput = {
        ...firstTable,
        AttributeDefinitions: [
          ...(firstTable.AttributeDefinitions ?? []),
          {
            AttributeName: 'anotherProp',
            AttributeType: 'S',
          },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'byAnotherProp',
            KeySchema: [
              {
                AttributeName: 'anotherProp',
                KeyType: 'HASH',
              },
            ],
            Projection: {
              ProjectionType: 'KEYS_ONLY',
            },
          },
          {
            IndexName: 'bySecondaryId',
            KeySchema: [
              {
                AttributeName: 'secondaryId',
                KeyType: 'HASH',
              },
            ],
            Projection: {
              ProjectionType: 'INCLUDE',
              NonKeyAttributes: ['thirdProp'],
            },
          },
        ],
      };

      const actual = await ensureTable(client, secondTable);

      expect(actual.TableDescription).toMatchObject({
        GlobalSecondaryIndexes: secondTable.GlobalSecondaryIndexes,
      });
    }, 30000);

    test('update ttl', async () => {
      const ttlSpy = vi.spyOn(client, 'updateTimeToLive');

      const TableName = getTestTableName('ttl-spec-test');
      const table: EnsureTableInput = {
        TableName,
        AttributeDefinitions: [
          {
            AttributeName: 'id',
            AttributeType: 'S',
          },
        ],
        KeySchema: [
          {
            AttributeName: 'id',
            KeyType: 'HASH',
          },
        ],
        BillingMode: 'PAY_PER_REQUEST',
        TimeToLiveSpecification: {
          Enabled: true,
          AttributeName: 'ttl',
        },
      };

      await createTable(client, table);

      const TimeToLiveSpecification = {
        Enabled: true,
        AttributeName: 'ttl',
      };
      table.TimeToLiveSpecification = TimeToLiveSpecification;

      await ensureTable(client, table);

      expect(ttlSpy).toHaveBeenCalledWith({
        TableName,
        TimeToLiveSpecification,
      });
    });
  });
});
