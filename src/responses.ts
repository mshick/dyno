import type {
  BatchGetCommandOutput,
  GetCommandOutput,
  QueryCommandOutput,
  ScanCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import isPlainObject from 'lodash/isPlainObject.js';
import type { NativeAttributeMap } from './types.ts';

function restoreItemBuffers(item: NativeAttributeMap) {
  for (const [k, v] of Object.entries(item)) {
    if (isPlainObject(v)) {
      restoreItemBuffers(v);
      continue;
    }

    if (Array.isArray(v)) {
      for (const vv of v) {
        if (isPlainObject(vv)) {
          restoreItemBuffers(vv);
        }
      }
      continue;
    }

    if (v instanceof Uint8Array) {
      item[k] = Buffer.from(v);
    }
  }

  return item;
}

export type ParseResponseOptions = {
  /**
   * Set to true to _not_ upgrade Uint8Arrays in responses to Buffers.
   */
  noBuffers?: boolean;
};

/**
 * Parse the items in a variety of responses. Converts Uint8Arrays to Buffers. Mutates response items.
 */
export function parseResponse<
  T extends
    | Pick<GetCommandOutput, 'Item'>
    | Pick<ScanCommandOutput, 'Items'>
    | Pick<QueryCommandOutput, 'Items'>
    | Pick<BatchGetCommandOutput, 'Responses'>,
>(response: T, options: ParseResponseOptions): T {
  if (options.noBuffers) {
    return response;
  }

  if ('Item' in response) {
    if (response.Item) {
      restoreItemBuffers(response.Item);
    }
  }

  if ('Items' in response) {
    if (response.Items) {
      response.Items.forEach(restoreItemBuffers);
    }
  }

  if ('Responses' in response) {
    if (response.Responses) {
      for (const items of Object.values(response.Responses)) {
        items.forEach(restoreItemBuffers);
      }
    }
  }

  return response;
}
