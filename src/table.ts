import {
  type CreateTableCommandInput,
  type DeleteTableCommandInput,
  type DynamoDB,
  type GlobalSecondaryIndexUpdate,
  IndexStatus,
  ResourceInUseException,
  ResourceNotFoundException,
  type TableDescription,
  TableStatus,
  TimeToLiveStatus,
  type UpdateTableCommandOutput,
  type UpdateTimeToLiveCommandOutput,
} from '@aws-sdk/client-dynamodb';
import isEqual from 'lodash/isEqual.js';
import type { EnsureTableInput, RequiredTableName } from './types.ts';
import { delay, getIndexUpdates, isEqualGSI } from './util.ts';

export type WaitForConnectionOptions = {
  stabilizeDelay?: number;
  maxDelay?: number;
};

export async function waitForConnection(
  client: DynamoDB,
  options: WaitForConnectionOptions = {},
): Promise<void> {
  const attemptDelay = 100;

  const stabilizeDelay = options.stabilizeDelay ?? 500;
  const maxDelay = options.maxDelay ?? 5000;
  const maxAttempts = Math.floor(maxDelay / attemptDelay);

  let attempts = 0;

  while (true) {
    if (maxAttempts > 0 && attempts >= maxAttempts) {
      throw new Error('Max connection attempts reached');
    }

    // biome-ignore lint/performance/noAwaitInLoops: is fine
    const tables = await client.listTables().catch(() => undefined);

    if (tables) {
      await delay(stabilizeDelay);
      break;
    }

    attempts += 1;
    await delay(attemptDelay);
  }
}

export function killConnection(client: DynamoDB): void {
  client.destroy();
}

export type WaitForIndexParams = {
  TableName: string;
  IndexName: string;
};

export type WaitForIndexOperation = typeof IndexStatus.DELETING | typeof IndexStatus.CREATING;

export async function waitForIndex(
  client: DynamoDB,
  { TableName, IndexName }: WaitForIndexParams,
  operation: WaitForIndexOperation,
) {
  let creatingOrDeleting = true;

  while (creatingOrDeleting) {
    await delay(1000);

    const tableDescription = await client.describeTable({ TableName });

    const index = tableDescription.Table?.GlobalSecondaryIndexes?.find(
      (index) => index.IndexName === IndexName,
    );

    if (operation === IndexStatus.DELETING) {
      creatingOrDeleting = index?.IndexStatus === IndexStatus.DELETING;
    } else {
      creatingOrDeleting = !index || index.IndexStatus === IndexStatus.CREATING;
    }
  }
}

export type WaitForTableParams = {
  TableName: string;
};

export type WaitForTableOperation = typeof TableStatus.DELETING | typeof TableStatus.CREATING;

export async function waitForTable(
  client: DynamoDB,
  { TableName }: WaitForTableParams,
  operation: WaitForTableOperation,
) {
  let creatingOrDeleting = true;

  while (creatingOrDeleting) {
    await delay(1000);

    const tableDescription = await client.describeTable({ TableName });

    if (operation === TableStatus.DELETING) {
      creatingOrDeleting = tableDescription?.Table?.TableStatus === TableStatus.DELETING;
    } else {
      creatingOrDeleting =
        !tableDescription?.Table || tableDescription?.Table?.TableStatus === IndexStatus.CREATING;
    }
  }
}

async function updateTableIndexes(
  client: DynamoDB,
  tableName: string,
  tableConfig: TableDescription,
  indexUpdates: GlobalSecondaryIndexUpdate[],
) {
  let result: UpdateTableCommandOutput | undefined;

  // Updating the indexes must happen sequentially
  for (const update of indexUpdates) {
    // Cannot run simultaneous ops on the same GSI
    const indexName = update.Delete?.IndexName ?? update.Create?.IndexName;
    const operation = update.Delete ? IndexStatus.DELETING : IndexStatus.CREATING;

    if (!indexName) {
      continue;
    }

    result = await client.updateTable({
      TableName: tableName,
      AttributeDefinitions: tableConfig.AttributeDefinitions,
      GlobalSecondaryIndexUpdates: [update],
    });

    await waitForIndex(client, { TableName: tableName, IndexName: indexName }, operation);
  }

  return result;
}

export async function createTable(
  client: DynamoDB,
  input: RequiredTableName<CreateTableCommandInput>,
): Promise<{ TableDescription: TableDescription }> {
  const { TableName } = input;

  try {
    const table = await client.describeTable({ TableName });
    return {
      TableDescription: table.Table!,
    };
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      try {
        const table = await client.createTable(input);
        return {
          TableDescription: table.TableDescription!,
        };
      } catch (err) {
        if (err instanceof ResourceInUseException) {
          await waitForTable(client, { TableName }, TableStatus.CREATING);
          const table = await client.describeTable({ TableName });
          return {
            TableDescription: table.Table!,
          };
        }

        throw new Error(`Failed to create ${TableName}`, { cause: err });
      }
    }

    throw new Error(`Failed to create ${TableName}`, { cause: err });
  }
}

export async function deleteTable(
  client: DynamoDB,
  input: RequiredTableName<DeleteTableCommandInput>,
) {
  const { TableName } = input;

  try {
    const table = await client.describeTable({ TableName });

    if (table?.Table?.TableStatus === TableStatus.ACTIVE) {
      await client.deleteTable(input);
      await waitForTable(client, { TableName }, TableStatus.DELETING);
    }
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      return;
    }

    throw new Error(`Failed to delete ${TableName}`, { cause: err });
  }
}

export type EnsureTableOutput = {
  TableDescription: TableDescription;
  TimeToLiveSpecification?: UpdateTimeToLiveCommandOutput['TimeToLiveSpecification'];
};

export async function ensureTable(
  client: DynamoDB,
  params: EnsureTableInput,
): Promise<EnsureTableOutput> {
  const { TimeToLiveSpecification, ...tableConfig } = params;
  const { TableName } = tableConfig;

  let { TableDescription } = await createTable(client, tableConfig);

  if (
    tableConfig.StreamSpecification?.StreamEnabled &&
    !isEqual(TableDescription.StreamSpecification, tableConfig.StreamSpecification)
  ) {
    TableDescription =
      (
        await client.updateTable({
          TableName,
          StreamSpecification: tableConfig.StreamSpecification,
        })
      ).TableDescription ?? TableDescription;
  }

  if (
    tableConfig.GlobalSecondaryIndexes &&
    !isEqualGSI(TableDescription.GlobalSecondaryIndexes, tableConfig.GlobalSecondaryIndexes)
  ) {
    const indexUpdates = getIndexUpdates(TableDescription, tableConfig);
    if (indexUpdates) {
      TableDescription =
        (await updateTableIndexes(client, TableName, tableConfig, indexUpdates))
          ?.TableDescription ?? TableDescription;
    }
  }

  let updateTimeToLive: UpdateTimeToLiveCommandOutput | undefined;

  if (TimeToLiveSpecification) {
    const { TimeToLiveDescription } = await client.describeTimeToLive({
      TableName,
    });
    if (
      TimeToLiveDescription &&
      (TimeToLiveDescription.TimeToLiveStatus === TimeToLiveStatus.DISABLED ||
        TimeToLiveDescription.TimeToLiveStatus === TimeToLiveStatus.DISABLING)
    ) {
      updateTimeToLive = await client.updateTimeToLive({
        TableName,
        TimeToLiveSpecification,
      });
    }
  }

  return {
    TableDescription,
    TimeToLiveSpecification: updateTimeToLive?.TimeToLiveSpecification,
  };
}
