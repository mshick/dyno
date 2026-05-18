import { faker } from '@faker-js/faker';
import {
  afterAll,
  afterEach,
  assert,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { Dyno, type DynoConfig } from '../dyno.ts';
import { createFixtures, getClient, getTestTableConfig } from './mocks.ts';

const dyno = Dyno.from(getClient());

afterEach(() => {
  vi.resetAllMocks();
});

afterAll(() => {
  dyno.destroy();
});

describe('Dyno', () => {
  describe('configuration and params', () => {
    test('expected properties', () => {
      assert.equal(typeof dyno.config, 'object', 'exposes config object');
      assert.equal(typeof dyno.listTables, 'function', 'exposes listTables function');
      assert.equal(typeof dyno.describeTable, 'function', 'exposes describeTable function');
      assert.equal(typeof dyno.batchGetItem, 'function', 'exposes batchGetItem function');
      assert.equal(typeof dyno.batchWriteItem, 'function', 'exposes batchWriteItem function');
      assert.equal(typeof dyno.deleteItem, 'function', 'exposes deleteItem function');
      assert.equal(typeof dyno.getItem, 'function', 'exposes getItem function');
      assert.equal(typeof dyno.putItem, 'function', 'exposes putItem function');
      assert.equal(typeof dyno.query, 'function', 'exposes query function');
      assert.equal(typeof dyno.scan, 'function', 'exposes scan function');
      assert.equal(typeof dyno.updateItem, 'function', 'exposes updateItem function');
      assert.equal(
        typeof dyno.batchGetItemRequests,
        'function',
        'exposes batchGetItemRequests function',
      );
      assert.equal(
        typeof dyno.batchWriteItemRequests,
        'function',
        'exposes batchWriteItemRequests function',
      );
      assert.equal(typeof dyno.batchGetAll, 'function', 'exposes batchGetAll function');
      assert.equal(typeof dyno.batchWriteAll, 'function', 'exposes batchWriteAll function');
      assert.equal(typeof dyno.createTable, 'function', 'exposes createTable function');
      assert.equal(typeof dyno.deleteTable, 'function', 'exposes deleteTable function');
      assert.equal(typeof dyno.queryStream, 'function', 'exposes queryStream function');
      assert.equal(typeof dyno.scanStream, 'function', 'exposes scanStream function');
      assert.equal(typeof dyno.putStream, 'function', 'exposes putStream function');

      // This project adds
      assert.equal(typeof dyno.destroy, 'function', 'exposes destroy function');
      assert.equal(typeof dyno.table, 'function', 'exposes table function');
      assert.equal(typeof dyno.batchDeleteAll, 'function', 'exposes batchDeleteAll function');
      assert.equal(typeof dyno.batchPutAll, 'function', 'exposes batchPutAll function');
      assert.equal(typeof dyno.ensureTable, 'function', 'exposes ensureTable function');
      assert.equal(typeof dyno.waitForIndex, 'function', 'exposes waitForIndex function');
      assert.equal(typeof dyno.waitForTable, 'function', 'exposes waitForTable function');
      assert.equal(typeof dyno.waitForConnection, 'function', 'exposes waitForConnection function');
      assert.equal(typeof dyno.killConnection, 'function', 'exposes killConnection function');
    });

    test('class exposes static functions', () => {
      // This project adds
      assert.equal(typeof Dyno.from, 'function', 'exposes from function');
      assert.equal(typeof Dyno.createClient, 'function', 'exposes createClient function');
      assert.equal(
        typeof Dyno.createDocumentClient,
        'function',
        'exposes createDocumentClient function',
      );
    });

    test('configuration', () => {
      const config: DynoConfig = {
        table: 'my-table',
        region: 'us-east-1',
        endpoint: 'http://localhost:8099',
        maxRetries: 10,
      };

      const dyno = new Dyno(config);

      assert.deepEqual(dyno.tableName, config.table, 'sets tableName');
      assert.equal(dyno.config.region, config.region, 'sets region');
      assert.equal(dyno.config.endpoint, config.endpoint, 'sets endpoint');
      assert.equal(dyno.config.maxRetries, config.maxRetries, 'sets maxRetries');
    });

    test('reuse client', () => {
      const options = {
        table: 'my-table',
        region: 'us-east-1',
        endpoint: 'http://localhost:8099',
      };

      const dyno = new Dyno(options);
      // @ts-expect-error
      const dyno2 = new Dyno(options, dyno._client);
      // @ts-expect-error
      assert.equal(dyno._client, dyno2._client, 'client is reused');
    });

    test('params - table name error', async () => {
      const options = {
        table: undefined,
        region: 'us-east-1',
        endpoint: 'http://localhost:8099',
      };

      const dyno = new Dyno(options);
      await expect(async () => dyno.describeTable()).rejects.toThrowError('TableName is required');
    });

    test('batch params - request items', () => {
      const options = {
        table: undefined,
        region: 'us-east-1',
        endpoint: 'http://localhost:8099',
      };

      const dyno = new Dyno(options);
      try {
        dyno.batchGetAll({
          RequestItems: { 'my-table': { Keys: [{ id: 'a' }] } },
        });
      } catch {
        assert.fail('these params are valid');
      }
    });

    test('batch params - table name error', () => {
      const options = {
        table: undefined,
        region: 'us-east-1',
        endpoint: 'http://localhost:8099',
      };

      const dyno = new Dyno(options);
      // @ts-expect-error
      expect(() => dyno.batchGetAll({ Keys: [{ id: 'a' }] })).toThrowError('TableName is required');
    });

    test('batchPutAll params - table name error', () => {
      const options = {
        table: undefined,
        region: 'us-east-1',
        endpoint: 'http://localhost:8099',
      };

      const dyno = new Dyno(options);
      // @ts-expect-error
      expect(() => dyno.batchPutAll([{ id: 'a' }])).toThrowError('TableName is required');
    });

    test('batchDeleteAll params - table name error', () => {
      const options = {
        table: undefined,
        region: 'us-east-1',
        endpoint: 'http://localhost:8099',
      };

      const dyno = new Dyno(options);
      // @ts-expect-error
      expect(() => dyno.batchDeleteAll([{ id: 'a' }])).toThrowError('TableName is required');
    });
  });

  describe('query', () => {
    const testTable = getTestTableConfig('idhash-category', 'query-pages-test');
    const tableName = testTable.TableName;
    const table = dyno.table(tableName);
    const fixtures = createFixtures({ count: 400 });

    beforeAll(async () => {
      await table.createTable(testTable);
      await table.batchPutAll(fixtures).sendAll();
    });

    afterAll(async () => {
      await table.deleteTable();
    });

    test('query - no pages', async () => {
      const limit = 100;
      const category = 'pets';

      const res = await table.query({
        KeyConditionExpression: 'category = :category',
        ExpressionAttributeValues: {
          ':category': category,
        },
        ScanIndexForward: true,
        IndexName: 'byCategory',
        Limit: limit,
      });

      const fix = fixtures.filter((item) => item.category === category);
      expect(res.Items?.length).toEqual(Math.min(limit, fix.length));
    });

    test('query - 2 pages', async () => {
      const category = 'pets';

      const res = await table.query({
        KeyConditionExpression: 'category = :category',
        ExpressionAttributeValues: {
          ':category': category,
        },
        IndexName: 'byCategory',
        Pages: 2,
      });

      expect(res.Items?.length).toEqual(
        fixtures.filter((item) => item.category === category).length,
      );
    });
  });

  describe('query - range', () => {
    let table: Dyno<string>;

    beforeEach(async () => {
      const testTable = getTestTableConfig('idhash-numrange', 'query-range-test');
      table = dyno.table(testTable.TableName);
      await table.createTable(testTable);
    });

    afterEach(async () => {
      await table.deleteTable();
    });

    test('query - gets all items across several pages', async () => {
      const id = faker.string.uuid();
      const fixturesWithId = createFixtures({ count: 1000, data: { id } });
      const fixtures = createFixtures({ count: 2345 });
      await table
        .batchPutAll([
          ...fixturesWithId.slice(0, 500),
          ...fixtures,
          ...fixturesWithId.slice(500, 1000),
        ])
        .sendAll();

      const startNum = 66;
      const endNum = 888;

      const res = await table.query({
        KeyConditionExpression: '#id = :id and #num BETWEEN :startNum AND :endNum',
        ExpressionAttributeNames: {
          '#id': 'id',
          '#num': 'num',
        },
        ExpressionAttributeValues: {
          ':id': id,
          ':startNum': startNum,
          ':endNum': endNum,
        },
        Pages: Number.POSITIVE_INFINITY,
      });

      expect(res.Items?.length).toEqual(endNum - startNum + 1);
    });
  });

  describe('scan', () => {
    const testTable = getTestTableConfig('idhash', 'scan-pages-test');
    const tableName = testTable.TableName;
    const table = dyno.table(tableName);
    const fixtures = createFixtures({ count: 400 });

    beforeAll(async () => {
      await table.createTable(testTable);
      await table.batchPutAll(fixtures).sendAll();
    });

    afterAll(async () => {
      await table.deleteTable();
    });

    test('scan - no pages', async () => {
      const limit = 100;
      const category = 'pets';

      const res = await table.scan({
        FilterExpression: 'category = :category',
        ExpressionAttributeValues: {
          ':category': category,
        },
        Limit: limit,
      });

      // There's no guarantee we'll find any items within the first page
      const fix = fixtures.filter((item) => item.category === category);
      expect(res.Items!.length <= fix.length).toBe(true);
    });

    test('scan - 2 pages', async () => {
      const category = 'pets';

      const res = await table.scan({
        FilterExpression: 'category = :category',
        ExpressionAttributeValues: {
          ':category': category,
        },
        Pages: 2,
      });

      expect(res.Items?.length).toEqual(
        fixtures.filter((item) => item.category === category).length,
      );
    });
  });

  describe('connection methods', () => {
    test('waitForConnection - resolves when connection is available', async () => {
      const mockDyno = Dyno.from(getClient());
      await expect(mockDyno.waitForConnection()).resolves.toBeUndefined();
      mockDyno.destroy();
    });

    test('waitForConnection - passes options to underlying function', async () => {
      const mockDyno = Dyno.from(getClient());
      const options = { stabilizeDelay: 100, maxDelay: 1000 };
      await expect(mockDyno.waitForConnection(options)).resolves.toBeUndefined();
      mockDyno.destroy();
    });

    test('killConnection - calls destroy on client', () => {
      const mockDyno = Dyno.from(getClient());
      // @ts-expect-error - accessing private property for test
      const destroySpy = vi.spyOn(mockDyno._client, 'destroy');

      mockDyno.killConnection();

      expect(destroySpy).toHaveBeenCalledOnce();
      mockDyno.destroy();
    });

    test('killConnection - returns void', () => {
      const mockDyno = Dyno.from(getClient());
      const result = mockDyno.killConnection();
      expect(result).toBeUndefined();
      mockDyno.destroy();
    });
  });

  describe('simple proxy methods', () => {
    const testTable = getTestTableConfig('idhash', 'proxy-methods-test');
    const tableName = testTable.TableName;
    const table = dyno.table(tableName);

    beforeAll(async () => {
      await table.createTable(testTable);
    });

    afterAll(async () => {
      await table.deleteTable();
    });

    test('batchGetItem', async () => {
      const fixtures = createFixtures({
        count: 100,
        data: { buffer: Buffer.from('my-buffer') },
      });
      await table.batchPutAll(fixtures).sendAll();
      const res = await table.batchGetAll({ Keys: [{ id: fixtures[10]!.id }] }).sendAll();
      expect(res.data?.Responses?.[tableName]).toEqual([fixtures[10]]);
      expect(Buffer.isBuffer(res.data?.Responses?.[tableName]?.[0]?.buffer)).toBe(true);
    });

    test('batchWriteItem', async () => {
      const fixture = createFixtures({ count: 1 })[0]!;
      await table.batchWriteAll([{ PutRequest: { Item: fixture } }]).sendAll();
      const res = await table.getItem({ Key: { id: fixture.id } });
      expect(res.Item).toEqual(fixture);
    });

    test('getItem', async () => {
      const fixture = createFixtures({
        count: 1,
        data: { buffer: Buffer.from('my-buffer') },
      })[0]!;
      await table.putItem({ Item: fixture });
      const res = await table.getItem({ Key: { id: fixture.id } });
      expect(Buffer.isBuffer(res.Item?.buffer)).toEqual(true);
    });

    test('deleteItem', async () => {
      const fixture = createFixtures({ count: 1 })[0]!;
      await table.putItem({ Item: fixture });
      await table.deleteItem({ Key: { id: fixture.id } });
      const res = await table.getItem({ Key: { id: fixture.id } });
      expect(res.Item).toEqual(undefined);
    });

    test('updateItem', async () => {
      const fixture = createFixtures({ count: 1 })[0]!;
      await table.putItem({ Item: fixture });
      await table.updateItem({
        Key: { id: fixture.id },
        UpdateExpression: 'set num = :num',
        ExpressionAttributeValues: {
          ':num': 666,
        },
        ReturnValues: 'ALL_NEW',
      });
      const res = await table.getItem({ Key: { id: fixture.id } });
      expect(res.Item?.num).toEqual(666);
    });
  });
});
