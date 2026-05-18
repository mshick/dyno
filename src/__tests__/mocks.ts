import { type CreateTableInput, DynamoDB } from '@aws-sdk/client-dynamodb';
import { faker } from '@faker-js/faker';
import cloneDeep from 'lodash/cloneDeep.js';
import type { RequiredTableName } from '../types.ts';

export type TestTable = RequiredTableName<CreateTableInput>;

const testTables: TestTable[] = [
  {
    TableName: 'idhash',
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
    ProvisionedThroughput: {
      ReadCapacityUnits: 10,
      WriteCapacityUnits: 10,
    },
  },
  {
    TableName: 'idhash-numrange',
    AttributeDefinitions: [
      {
        AttributeName: 'id',
        AttributeType: 'S',
      },
      {
        AttributeName: 'num',
        AttributeType: 'N',
      },
    ],
    KeySchema: [
      {
        AttributeName: 'id',
        KeyType: 'HASH',
      },
      {
        AttributeName: 'num',
        KeyType: 'RANGE',
      },
    ],
    ProvisionedThroughput: {
      ReadCapacityUnits: 10,
      WriteCapacityUnits: 10,
    },
  },
  {
    TableName: 'idhash-category',
    KeySchema: [
      {
        AttributeName: 'id',
        KeyType: 'HASH',
      },
    ],
    AttributeDefinitions: [
      {
        AttributeName: 'id',
        AttributeType: 'S',
      },
      {
        AttributeName: 'category',
        AttributeType: 'S',
      },
    ],
    ProvisionedThroughput: {
      ReadCapacityUnits: 1,
      WriteCapacityUnits: 1,
    },
    GlobalSecondaryIndexes: [
      {
        IndexName: 'byCategory',
        KeySchema: [
          {
            AttributeName: 'category',
            KeyType: 'HASH',
          },
        ],
        Projection: {
          ProjectionType: 'ALL',
        },
        ProvisionedThroughput: {
          ReadCapacityUnits: 1,
          WriteCapacityUnits: 1,
        },
      },
    ],
  },
];

export function getTestTableName(name: string) {
  return `${name}-${faker.number.int()}`;
}

export function getTestTableConfig(
  tableName: 'idhash' | 'idhash-category' | 'idhash-numrange',
  name: string,
) {
  const found = testTables.find((t) => t.TableName === tableName);

  if (!found) {
    throw new Error('invalid test table');
  }

  return cloneDeep({ ...found, TableName: getTestTableName(name) });
}

type Fixture = {
  id: string;
  data: string;
  num: number;
  category: string[];
  isLarge: boolean;
  fileSize: number;
};

export function createRandomFixture(data?: Partial<Fixture>) {
  return (_: unknown, i: number) => ({
    id: faker.string.uuid(),
    data: faker.string.alphanumeric(5 * 1024),
    num: i,
    category: faker.helpers.arrayElement(['pets', 'family']),
    isLarge: faker.datatype.boolean(),
    fileSize: faker.number.int({ min: 10, max: 1000 }),
    ...data,
  });
}

export function createFixtures({
  count,
  data,
}: {
  count: number;
  data?: Partial<Fixture> & Record<string, any>;
}) {
  return faker.helpers.multiple(createRandomFixture(data), {
    count,
  });
}

export function getClient() {
  return new DynamoDB({
    endpoint: process.env.DYNAMO_DB_ENDPOINT,
    region: process.env.DYNAMO_DB_REGION,
  });
}
