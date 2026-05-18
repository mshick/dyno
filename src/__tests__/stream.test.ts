import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ReturnConsumedCapacity } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
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
import { Dyno } from '../dyno.ts';
import { createReadStream } from '../stream.ts';
import { writeCost } from '../util.ts';
import { createFixtures, getClient, getTestTableConfig } from './mocks.ts';

const putTableName = 'idhash';
const scanTableName = 'idhash';
const queryTableName = 'idhash-numrange';

const client = getClient();
const dyno = Dyno.from(client);

afterEach(() => {
  vi.resetAllMocks();
});

afterAll(() => {
  dyno.destroy();
});

describe('stream', () => {
  describe.sequential('scanStream', () => {
    let table: Dyno<string>;

    beforeEach(async () => {
      const testTable = getTestTableConfig(scanTableName, 'scan-stream-test');
      table = dyno.table(testTable.TableName);
      await table.createTable(testTable);
    });

    afterEach(async () => {
      await table.deleteTable();
    });

    test('scan', async () => {
      const fixtures = createFixtures({ count: 2345 });
      await table.batchPutAll(fixtures).sendAll();

      return new Promise<void>((done) => {
        let count = 0;

        const scan = table.scanStream();

        scan
          .on('error', (err) => {
            assert.ifError(err, 'should not error');
          })
          .on('data', (item) => {
            count++;

            if (!item.id) {
              assert.fail('stream record has no id');
            }

            if (item.data.length !== 5 * 1024) {
              assert.fail('streamed record has incorrect buffer length');
            }

            if (count > 2345) {
              scan.destroy();
              assert.fail('streamed too many records');
            }
          })
          .on('end', () => {
            assert.equal(count, 2345, 'scanned all records');
            scan.destroy();
            done();
          });
      });
    });

    test('scan - buffers are restored', async () => {
      const fixtures = createFixtures({
        count: 10,
        data: { buffer: Buffer.from('my-buffer') },
      });
      await table.batchPutAll(fixtures).sendAll();

      return new Promise<void>((done) => {
        const scan = table.scanStream();

        scan
          .on('error', (err) => {
            assert.ifError(err, 'should not error');
          })
          .on('data', (item) => {
            if (!Buffer.isBuffer(item.buffer)) {
              assert.fail('buffer was not restored');
            }
          })
          .on('end', () => {
            scan.destroy();
            done();
          });
      });
    });

    test('scan - noBuffer option', async () => {
      table.config.noBuffers = true;
      const fixtures = createFixtures({
        count: 10,
        data: { buffer: Buffer.from('my-buffer') },
      });
      await table.batchPutAll(fixtures).sendAll();

      return new Promise<void>((done) => {
        const scan = table.scanStream();

        scan
          .on('error', (err) => {
            assert.ifError(err, 'should not error');
          })
          .on('data', (item) => {
            if (!(item.buffer instanceof Uint8Array)) {
              assert.fail('Uint8Array was not returned');
            }
          })
          .on('end', () => {
            scan.destroy();
            done();
          });
      });
    });

    test('consumed capacity', async () => {
      const fixtures = createFixtures({ count: 2345 });
      await table.batchPutAll(fixtures).sendAll();

      return new Promise<void>((done) => {
        let count = 0;

        const scan = table.scanStream({
          ReturnConsumedCapacity: ReturnConsumedCapacity.TOTAL,
          Limit: 20,
        });

        scan
          .on('error', (err) => {
            assert.ifError(err, 'should not error');
          })
          .on('data', () => {
            count++;
            if (count > 20) {
              scan.destroy();
              assert.fail('streamed too many records');
            }
          })
          .on('end', () => {
            assert.equal(count, 20, 'scanned all records');
            assert.deepEqual(
              scan.ConsumedCapacity,
              {
                Table: {},
                TableName: table.tableName,
                CapacityUnits: 13,
                LocalSecondaryIndexes: {},
                GlobalSecondaryIndexes: {},
              },
              'returns consumed capacity',
            );
            scan.destroy();
            done();
          });
      });
    });

    test('filter with empty pages', async () => {
      const fixtures = createFixtures({ count: 2345 });
      const fixture = fixtures[2344]!;
      fixture.id = 'needle';

      await table.batchPutAll(fixtures).sendAll();

      return new Promise<void>((done) => {
        let found: any;

        const scan = table.scanStream(
          {
            ExpressionAttributeValues: {
              ':id': fixture.id,
            },
            ExpressionAttributeNames: {
              '#id': 'id',
            },
            FilterExpression: '#id = :id',
          },
          {
            // Ensure multiple pages
            pageSize: 100,
          },
        );

        scan
          .on('error', (err) => {
            assert.ifError(err, 'should not error');
          })
          .on('data', (item) => {
            found = item;
          })
          .on('end', () => {
            assert.equal(scan.ScannedCount, fixtures.length, 'scanned everything');
            assert.deepEqual(found, fixture, 'found our needle');
            scan.destroy();
            done();
          });
      });
    });
  });

  describe.sequential('createReadStream', () => {
    test('createReadStream', async () => {
      const mockDbClient = DynamoDBDocument.from(getClient());

      const mockSend = vi
        .spyOn(mockDbClient, 'send')
        .mockImplementation((_command: any, cb: any) => {
          (cb as (err: any, data?: any) => void)(null, undefined);
        });

      const readStream = createReadStream(mockDbClient, {
        TableName: 'mock-table',
        KeyConditionExpression: 'id  = :id',
      });

      expect(readStream.isLastPage()).toBe(false);
      expect(readStream.hasNextPage()).toBe(true);

      await pipeline(readStream, new PassThrough());

      expect(mockSend).toHaveBeenCalled();

      expect(readStream.isLastPage()).toBe(true);
      expect(readStream.hasNextPage()).toBe(false);
    });
  });

  describe.sequential('queryStream', () => {
    const testTable = getTestTableConfig(queryTableName, 'query-stream-test');
    const tableName = testTable.TableName;
    const table = dyno.table(tableName);
    const fakeId = 'fake-id';

    beforeAll(async () => {
      await table.createTable(testTable);
    });

    afterAll(async () => {
      await table.deleteTable();
    });

    test('query', async () => {
      const fixtures = createFixtures({ count: 2345, data: { id: fakeId } });
      await table.batchPutAll(fixtures).sendAll();

      return new Promise<void>((done) => {
        let count = 0;

        const query = table.queryStream(
          {
            KeyConditionExpression: 'id  = :id',
            ExpressionAttributeValues: {
              ':id': fakeId,
            },
            // Cover a case where we set this and pageSize
            Limit: 3000,
          },
          { pageSize: 100 },
        );

        query
          .on('error', (err) => {
            assert.ifError(err, 'should not error');
          })
          .on('data', (item) => {
            count++;

            if (!item.id) {
              assert.fail('stream record has no id');
            }

            if (item.data.length !== 5 * 1024) {
              assert.fail('streamed record has incorrect buffer length');
            }

            if (count > 2345) {
              query.destroy();
              assert.fail('streamed too many records');
            }
          })
          .on('end', () => {
            assert.equal(count, 2345, 'scanned all records');
            done();
          });
      });
    });
  });

  describe.sequential('putStream', () => {
    test('put', async () => {
      const testTable = getTestTableConfig(putTableName, 'put-stream-test');
      const table = dyno.table(testTable.TableName);

      await table.createTable(testTable);

      const fixtures = createFixtures({ count: 2345 });

      const test = async () =>
        new Promise<void>((done) => {
          const stream = table.putStream({ ReturnConsumedCapacity: 'TOTAL' });

          let capacityUnits = 0;

          for (const fixture of fixtures) {
            stream.write(fixture);
            capacityUnits += writeCost(fixture);
          }

          let count = 0;

          stream
            .on('finish', () => {
              assert.deepEqual(
                stream.ConsumedCapacity,
                {
                  TableName: table.tableName,
                  GlobalSecondaryIndexes: {},
                  LocalSecondaryIndexes: {},
                  Table: {},
                  CapacityUnits: capacityUnits,
                },
                'aggregated consumed capacity',
              );

              table
                .scanStream()
                .on('error', (err) => {
                  assert.ifError(err, 'should not error');
                })
                .on('data', () => {
                  count += 1;
                })
                .on('end', () => {
                  assert.equal(count, fixtures.length, 'wrote all fixtures');
                  done();
                });
            })
            .end();
        });

      await test();

      await table.deleteTable();
    });

    test('put large items', async () => {
      const testTable = getTestTableConfig(putTableName, 'put-stream-test');
      const table = dyno.table(testTable.TableName);

      await table.createTable(testTable);

      const fixtures = createFixtures({
        count: 100,
        data: { data: faker.string.alphanumeric(300 * 1024) },
      });

      const test = async () =>
        new Promise<void>((done) => {
          const stream = table.putStream({ ReturnConsumedCapacity: 'TOTAL' });

          let capacityUnits = 0;

          for (const fixture of fixtures) {
            stream.write(fixture);
            capacityUnits += writeCost(fixture);
          }

          let count = 0;

          stream
            .on('finish', () => {
              assert.deepEqual(
                stream.ConsumedCapacity,
                {
                  TableName: table.tableName,
                  GlobalSecondaryIndexes: {},
                  LocalSecondaryIndexes: {},
                  Table: {},
                  CapacityUnits: capacityUnits,
                },
                'aggregated consumed capacity',
              );

              table
                .scanStream(undefined, { pageSize: 25 })
                .on('error', (err) => {
                  assert.ifError(err, 'should not error');
                })
                .on('data', () => {
                  count += 1;
                })
                .on('end', () => {
                  assert.equal(count, fixtures.length, 'wrote all fixtures');
                  done();
                });
            })
            .end();
        });

      await test();

      await table.deleteTable();
    });
  });
});
