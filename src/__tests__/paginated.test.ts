import { afterAll, afterEach, assert, beforeAll, describe, test, vi } from 'vitest';
import { Dyno } from '../dyno.ts';
import { readPaginatedStream } from '../paginated.ts';
import { createFixtures, getClient, getTestTableConfig } from './mocks.ts';

const client = getClient();
const dyno = Dyno.from(client);

const mockId = 'mock-id';

afterEach(() => {
  vi.resetAllMocks();
});

afterAll(() => {
  dyno.destroy();
});

describe('paginated', () => {
  const testTable = getTestTableConfig('idhash-numrange', 'paginated-stream-test');
  const tableName = testTable.TableName;
  const table = dyno.table(tableName);
  const fixtures = createFixtures({ count: 2345, data: { id: mockId } });

  beforeAll(async () => {
    await table.createTable(testTable);
    await table.batchPutAll(fixtures).sendAll();
  });

  afterAll(async () => {
    await table.deleteTable();
  });

  test('query, negative pages', () => {
    try {
      table.queryStream({
        ExpressionAttributeNames: { '#id': 'id' },
        ExpressionAttributeValues: { ':id': mockId },
        KeyConditionExpression: '#id = :id',
        Pages: -56,
      });
      assert.fail('this should not succeed');
    } catch (err: any) {
      assert.equal(
        err.message,
        'Pages must be an integer greater than 0',
        'Pages must be greater than 0',
      );
    }
  });

  test('query, 1 page', async () => {
    const pageSize = 203;
    const pages = 1;

    const stream = table.queryStream({
      ExpressionAttributeNames: { '#id': 'id' },
      ExpressionAttributeValues: { ':id': mockId },
      KeyConditionExpression: '#id = :id',
      Pages: pages,
    });

    const data = await readPaginatedStream(stream);

    const items = fixtures.slice(0, pageSize * pages);

    assert.deepEqual(
      data,
      {
        Items: items,
        Count: items.length,
        ScannedCount: items.length,
        LastEvaluatedKey: { id: mockId, num: pageSize * pages - 1 },
        ConsumedCapacity: undefined,
      },
      'one page of results',
    );
  });

  test('query, 1 page, explicit pageSize', async () => {
    const pageSize = 100;
    const pages = 1;

    const stream = table.queryStream(
      {
        ExpressionAttributeNames: { '#id': 'id' },
        ExpressionAttributeValues: { ':id': mockId },
        KeyConditionExpression: '#id = :id',
        Pages: pages,
      },
      { pageSize },
    );

    const data = await readPaginatedStream(stream);

    const items = fixtures.slice(0, pageSize * pages);

    assert.deepEqual(
      data,
      {
        Items: items,
        Count: items.length,
        ScannedCount: items.length,
        LastEvaluatedKey: { id: mockId, num: pageSize * pages - 1 },
        ConsumedCapacity: undefined,
      },
      'one page of results',
    );
  });

  test('query, 2 pages', async () => {
    const pageSize = 203;
    const pages = 2;

    const stream = table.queryStream({
      ExpressionAttributeNames: { '#id': 'id' },
      ExpressionAttributeValues: { ':id': mockId },
      KeyConditionExpression: '#id = :id',
      Pages: 2,
    });

    const data = await readPaginatedStream(stream);

    const items = fixtures.slice(0, pageSize * pages);

    assert.deepEqual(
      data,
      {
        Items: items,
        Count: items.length,
        ScannedCount: items.length,
        LastEvaluatedKey: { id: mockId, num: pageSize * pages - 1 },
        ConsumedCapacity: undefined,
      },
      'one page of results',
    );
  });

  test('query, Infinity pages', async () => {
    const pages = Number.POSITIVE_INFINITY;

    const stream = table.queryStream({
      ExpressionAttributeNames: { '#id': 'id' },
      ExpressionAttributeValues: { ':id': mockId },
      KeyConditionExpression: '#id = :id',
      Pages: pages,
    });

    const data = await readPaginatedStream(stream);

    const items = fixtures;

    assert.deepEqual(
      data,
      {
        Items: items,
        Count: items.length,
        ScannedCount: items.length,
        LastEvaluatedKey: undefined,
        ConsumedCapacity: undefined,
      },
      'one page of results',
    );
  });
});
