import {
  type CreateTableCommandInput,
  type DeleteTableCommandInput,
  type DescribeTableCommandInput,
  DynamoDB,
  type DynamoDBClientConfig,
  type ListTablesCommandInput,
} from '@aws-sdk/client-dynamodb';
import {
  type BatchGetCommandInput,
  type BatchWriteCommandInput,
  type DeleteCommandInput,
  DynamoDBDocument,
  type GetCommandInput,
  type PutCommandInput,
  type TranslateConfig,
  type UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { HttpHandlerOptions } from '@smithy/types';
import { getClientConfig, getClientTranslateConfig } from './client.ts';
import { TableNameError } from './error.ts';
import { readPaginatedStream } from './paginated.ts';
import {
  batchDeleteAll,
  batchGetAll,
  batchGetItemRequests,
  batchPutAll,
  batchWriteAll,
  batchWriteItemRequests,
} from './requests/requests.ts';
import type { SendAllOptions } from './requests/send-all.ts';
import type { SendCompletelyOptions } from './requests/send-completely.ts';
import { type ParseResponseOptions, parseResponse } from './responses.ts';
import {
  createPutStream,
  createReadStream,
  type PutStreamInput,
  type PutStreamOptions,
  type QueryInput,
  type QueryOutput,
  type ReadStreamOptions,
  type ScanInput,
  type ScanOutput,
} from './stream.ts';
import {
  createTable,
  deleteTable,
  ensureTable,
  killConnection,
  type WaitForConnectionOptions,
  type WaitForIndexOperation,
  type WaitForIndexParams,
  type WaitForTableOperation,
  type WaitForTableParams,
  waitForConnection,
  waitForIndex,
  waitForTable,
} from './table.ts';
import type {
  EnsureTableInput,
  MaybeTableName,
  NativeAttributeMap,
  OptionalTableName,
  RequiredTableName,
} from './types.ts';

export type DynoConfig<T extends string | undefined = string> = DynamoDBClientConfig & {
  table: T;
} & SendCompletelyOptions &
  SendAllOptions &
  ParseResponseOptions & { translateConfig?: TranslateConfig };

/**
 * Extends an interface matching the `dynoExtensions` in `dyno`. Native methods
 * can be
 */
export class Dyno<TableName extends string | undefined = undefined> {
  /**
   * Create a DynamoDB client with defaults
   */
  static createClient(config: DynamoDBClientConfig) {
    return new DynamoDB(getClientConfig(config));
  }

  /**
   * Create a DynamoDBDocument client with defaults
   */
  static createDocumentClient(client: DynamoDB, translateConfig?: TranslateConfig) {
    return DynamoDBDocument.from(client, getClientTranslateConfig(translateConfig));
  }

  /**
   * Create a Dynamo instance from a client
   *
   * Note: Not in Dyno
   */
  static from(client: DynamoDB) {
    return new Dyno<undefined>({ table: undefined }, client);
  }

  public readonly config: DynoConfig<TableName>;
  public readonly tableName: TableName;

  private readonly _client: DynamoDB;
  private readonly _docClient: DynamoDBDocument;

  constructor(config: DynoConfig<TableName>, client?: DynamoDB) {
    let { table, maxRetries, concurrency, translateConfig, ...clientConfig } = config;

    if (client) {
      this._client = client;
    } else {
      clientConfig = getClientConfig(clientConfig);
      this._client = Dyno.createClient(clientConfig);
    }

    translateConfig = getClientTranslateConfig(translateConfig);
    this._docClient = DynamoDBDocument.from(this._client, translateConfig);

    this.tableName = table;

    this.config = {
      table,
      maxRetries,
      concurrency,
      translateConfig,
      ...clientConfig,
    };
  }

  /**
   * Destroy the DynamoDB client
   *
   * Note: Not in Dyno
   */
  destroy() {
    this._client.destroy();
  }

  /**
   * Get a sub-client, scoped to a single table. Similar to the behavior of the Dyno class constructor.
   *
   * Note: Not in Dyno
   */
  table(tableName: string) {
    return new Dyno({ ...this.config, table: tableName }, this._client);
  }

  async ensureTable(params?: OptionalTableName<EnsureTableInput, TableName>) {
    return ensureTable(this._client, this.paramsWithTableName(params));
  }

  async waitForConnection(options?: WaitForConnectionOptions): Promise<void> {
    return waitForConnection(this._client, options);
  }

  killConnection(): void {
    killConnection(this._client);
  }

  async waitForIndex(
    operation: WaitForIndexOperation,
    params: OptionalTableName<WaitForIndexParams, TableName>,
  ) {
    return waitForIndex(this._client, this.paramsWithTableName(params), operation);
  }

  async waitForTable(
    operation: WaitForTableOperation,
    params?: OptionalTableName<WaitForTableParams, TableName>,
  ) {
    return waitForTable(this._client, this.paramsWithTableName(params), operation);
  }

  /**
   * List the tables available in a given region. Passthrough to [DynamoDB.listTables](http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB.html#listTables-property).
   */
  async listTables(params?: ListTablesCommandInput) {
    return this._client.listTables(params ?? {});
  }

  /**
   * Get table information. Passthrough to [DynamoDB.describeTable](http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB.html#describTable-property).
   */
  async describeTable(params?: OptionalTableName<DescribeTableCommandInput, TableName>) {
    const { Table } = await this._client.describeTable(this.paramsWithTableName(params));

    if (!Table) {
      throw new Error('Missing Table in response');
    }

    return { Table };
  }

  /**
   * Perform a batch of get operations. Passthrough to [DocumentClient.batchGet](http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB/DocumentClient.html#batchGet-property).
   */
  async batchGetItem(
    params: TableName extends string
      ? NonNullable<BatchGetCommandInput['RequestItems']>[string]
      : BatchGetCommandInput,
    options?: HttpHandlerOptions,
  ) {
    return parseResponse(
      await this._docClient.batchGet(this.batchParams(params), options),
      this.config,
    );
  }

  /**
   * Perform a batch of write operations. Passthrough to [DocumentClient.batchWrite](http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB/DocumentClient.html#batchWrite-property).
   */
  async batchWriteItem(
    params: TableName extends string
      ? NonNullable<BatchWriteCommandInput['RequestItems']>[string]
      : BatchWriteCommandInput,
    options?: HttpHandlerOptions,
  ) {
    return this._docClient.batchWrite(this.batchParams(params), options);
  }

  /**
   * Delete a single record. Passthrough to [DocumentClient.delete](http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB/DocumentClient.html#delete-property).
   */
  async deleteItem(params: OptionalTableName<DeleteCommandInput, TableName>) {
    return this._docClient.delete(this.paramsWithTableName(params));
  }

  /**
   * Get a single record. Passthrough to [DocumentClient.get](http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB/DocumentClient.html#get-property).
   */
  async getItem(params: OptionalTableName<GetCommandInput, TableName>) {
    return parseResponse(await this._docClient.get(this.paramsWithTableName(params)), this.config);
  }

  /**
   * Put a single record. Passthrough to [DocumentClient.put](http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB/DocumentClient.html#put-property).
   */
  async putItem(params: OptionalTableName<PutCommandInput, TableName>) {
    return this._docClient.put(this.paramsWithTableName(params));
  }

  /**
   * Update a single record. Passthrough to [DocumentClient.update](http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB/DocumentClient.html#update-property).
   */
  async updateItem(params: OptionalTableName<UpdateCommandInput, TableName>) {
    return this._docClient.update(this.paramsWithTableName(params));
  }

  /**
   * Break a large batch of get operations into a set of requests that can be
   * sent individually or concurrently.
   */
  batchGetItemRequests(
    params: TableName extends string
      ? NonNullable<BatchGetCommandInput['RequestItems']>[string]
      : BatchGetCommandInput,
    options?: HttpHandlerOptions & SendAllOptions,
  ) {
    return batchGetItemRequests(
      this._docClient,
      this.batchParams(params),
      this.batchOptions(options),
    );
  }

  /**
   * Break a large batch of write operations into a set of requests that can be
   * sent individually or concurrently.
   */
  batchWriteItemRequests(
    params: TableName extends string
      ? NonNullable<BatchWriteCommandInput['RequestItems']>[string]
      : BatchWriteCommandInput,
    options?: HttpHandlerOptions & SendAllOptions,
  ) {
    return batchWriteItemRequests(
      this._docClient,
      this.batchParams(params),
      this.batchOptions(options),
    );
  }

  /**
   * Break a large batch of get operations into a set of requests that are intended
   * to be sent concurrently.
   */
  batchGetAll(
    params: TableName extends string
      ? NonNullable<BatchGetCommandInput['RequestItems']>[string]
      : BatchGetCommandInput,
    options?: HttpHandlerOptions & SendCompletelyOptions,
  ) {
    return batchGetAll(this._docClient, this.batchParams(params), this.batchOptions(options));
  }

  /**
   * Break a large batch of write operations into a set of requests that are intended
   * to be sent concurrently.
   */
  batchWriteAll(
    params: TableName extends string
      ? NonNullable<BatchWriteCommandInput['RequestItems']>[string]
      : BatchWriteCommandInput,
    options?: HttpHandlerOptions & SendCompletelyOptions,
  ) {
    return batchWriteAll(this._docClient, this.batchParams(params), this.batchOptions(options));
  }

  /**
   * Sugar on batchWriteAll, only for table clients
   */
  batchPutAll(
    items: TableName extends string ? NativeAttributeMap[] : never,
    options?: HttpHandlerOptions & SendCompletelyOptions,
  ) {
    if (!this.tableName) {
      throw new TableNameError();
    }

    return batchPutAll(this._docClient, this.tableName, items, this.batchOptions(options));
  }

  /**
   * Sugar on batchWriteAll, only for table clients
   */
  batchDeleteAll(
    items: TableName extends string ? NativeAttributeMap[] : never,
    options?: HttpHandlerOptions & SendCompletelyOptions,
  ) {
    if (!this.tableName) {
      throw new TableNameError();
    }

    return batchDeleteAll(this._docClient, this.tableName, items, this.batchOptions(options));
  }

  /**
   * Create a table. Passthrough to [DynamoDB.createTable](http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB.html#createTable-property),
   * except the function polls DynamoDB until the table is ready to accept
   * reads and writes, at which point the callback function is called.
   */
  async createTable(params: OptionalTableName<CreateTableCommandInput, TableName>) {
    return createTable(this._client, this.paramsWithTableName(params));
  }

  /**
   * Delete a table. Passthrough to [DynamoDB.deleteTable](http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB.html#deleteTable-property),
   * except the function polls DynamoDB until the table is ready to accept
   * reads and writes, at which point the callback function is called.
   */
  async deleteTable(params?: OptionalTableName<DeleteTableCommandInput, TableName>) {
    return deleteTable(this._client, this.paramsWithTableName(params));
  }

  /**
   * Provide the results of a query as a [Readable Stream](https://nodejs.org/api/stream.html#stream_class_stream_readable).
   * This function will paginate through query responses, making HTTP requests
   * as the caller reads from the stream.
   */
  queryStream(params: OptionalTableName<QueryInput, TableName>, options?: ReadStreamOptions) {
    return createReadStream(this._docClient, this.paramsWithTableName(params), {
      ...options,
      mode: 'query',
    });
  }

  /**
   * Provide the results of a scan as a [Readable Stream](https://nodejs.org/api/stream.html#stream_class_stream_readable).
   * This function will paginate through query responses, making HTTP requests
   * as the caller reads from the stream.
   */
  scanStream(params?: OptionalTableName<ScanInput, TableName>, options?: ReadStreamOptions) {
    return createReadStream(this._docClient, this.paramsWithTableName(params), {
      ...options,
      mode: 'scan',
    });
  }

  /**
   * Creates a [Writable stream](https://nodejs.org/api/stream.html#stream_class_stream_writable).
   * Writing individual records to the stream will aggregate them into sets of
   * 25 items and submit them as `BatchWriteItem` requests.
   */
  putStream(params?: OptionalTableName<PutStreamInput, TableName>, options?: PutStreamOptions) {
    const { concurrency, maxRetries } = this.config;
    return createPutStream(this._docClient, this.paramsWithTableName(params), {
      concurrency,
      maxRetries,
      ...options,
    });
  }

  /**
   * Query a table or secondary index. Passthrough to [DocumentClient.query](http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB/DocumentClient.html#query-property).
   */
  async query(
    params: OptionalTableName<QueryInput, TableName>,
    options?: ReadStreamOptions,
  ): Promise<QueryOutput> {
    if (!params?.Pages) {
      return this._docClient.query(this.paramsWithTableName(params));
    }

    return readPaginatedStream(this.queryStream(params, options));
  }

  /**
   * Scan a table or secondary index. Passthrough to [DocumentClient.scan](http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB/DocumentClient.html#scan-property).
   */
  async scan(
    params?: OptionalTableName<ScanInput, TableName>,
    options?: ReadStreamOptions,
  ): Promise<ScanOutput> {
    if (!params?.Pages) {
      return this._docClient.scan(this.paramsWithTableName(params));
    }

    return readPaginatedStream(this.scanStream(params, options));
  }

  private paramsWithTableName<T extends MaybeTableName>(
    params?: OptionalTableName<T, TableName>,
  ): RequiredTableName<T> {
    // Class-defined tableName takes precedence
    const TableName = this.tableName ?? (params as T)?.TableName;

    if (!TableName) {
      throw new TableNameError();
    }

    return { TableName, ...(params as Omit<T, 'TableName'>) };
  }

  private batchParams<T extends BatchWriteCommandInput | BatchGetCommandInput>(
    requestOrItems: TableName extends string ? NonNullable<T['RequestItems']>[string] : T,
  ): T {
    let params: T;

    if ('RequestItems' in requestOrItems) {
      params = requestOrItems as T;
    } else {
      if (!this.tableName) {
        throw new TableNameError();
      }

      params = {
        RequestItems: { [this.tableName]: requestOrItems },
      } as T;
    }

    return params;
  }

  private batchOptions(
    options?: (SendAllOptions | SendCompletelyOptions) & HttpHandlerOptions,
  ): SendAllOptions & SendCompletelyOptions & HttpHandlerOptions & ParseResponseOptions {
    const { concurrency, maxRetries, noBuffers } = this.config;
    return {
      concurrency,
      maxRetries,
      noBuffers,
      ...options,
    };
  }
}
