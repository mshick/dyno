import type {
  CreateTableCommandInput,
  GlobalSecondaryIndex,
  KeySchemaElement,
  KeyType,
  LocalSecondaryIndex,
  UpdateTimeToLiveCommandInput,
} from '@aws-sdk/client-dynamodb';
import type { NativeAttributeValue } from '@aws-sdk/util-dynamodb';

/**
 * Can represent either a marshalled or unmarshalled document.
 */
export type NativeAttributeMap = Record<string, NativeAttributeValue>;

export type MaybeTableName = { TableName?: string | undefined };

/**
 * AWS types make most tables `string | undefined` which is problematic
 */
export type RequiredTableName<T extends MaybeTableName> = Omit<T, 'TableName'> & {
  TableName: string;
};

/**
 * Enforces that a TableName not be present, to avoid confusion in some inputs
 */
export type OptionalTableName<
  T extends MaybeTableName,
  U extends string | undefined,
> = U extends string ? Omit<T, 'TableName'> : Omit<T, 'TableName'> & { TableName: string };

type MaybeCompleteIndex = {
  IndexName: string | undefined;
  KeySchema: KeySchemaElement[] | undefined;
};

type RequiredCompleteIndex<T extends MaybeCompleteIndex> = Omit<
  T,
  'IndexName' | 'KeySchmaElement'
> & {
  IndexName: string;
  KeySchema: DynoKeySchemaElement[];
};

export type DynoKeySchemaElement = Omit<KeySchemaElement, 'AttributeName' | 'KeyType'> & {
  AttributeName: string;
  KeyType: KeyType;
};
export type DynoLocalSecondaryIndex = RequiredCompleteIndex<LocalSecondaryIndex>;
export type DynoGlobalSecondaryIndex = RequiredCompleteIndex<GlobalSecondaryIndex>;

export type EnsureTableInput = Omit<
  CreateTableCommandInput,
  'TableName' | 'KeySchema' | 'LocalSecondaryIndexes' | 'GlobalSecondaryIndexes'
> & {
  TableName: string;
  KeySchema: DynoKeySchemaElement[];
  LocalSecondaryIndexes?: DynoLocalSecondaryIndex[];
  GlobalSecondaryIndexes?: DynoGlobalSecondaryIndex[];
} & Partial<UpdateTimeToLiveCommandInput>;
