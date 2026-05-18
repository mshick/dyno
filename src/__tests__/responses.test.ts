import type {
  BatchGetCommandOutput,
  GetCommandOutput,
  ScanCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { describe, expect, test } from 'vitest';
import { parseResponse } from '../responses.ts';

describe('parseResponse', () => {
  test('get response', () => {
    const buff = Buffer.from('my-buffer');
    const response: Omit<GetCommandOutput, '$metadata'> = {
      Item: {
        foo: 'FOO',
        buff: new Uint8Array(buff),
        obj: {
          buff: new Uint8Array(buff),
        },
        arr: [{ buff: new Uint8Array(buff) }],
      },
    };

    const res = parseResponse(response, {});

    expect(Buffer.isBuffer(res.Item?.buff)).toEqual(true);
    expect(Buffer.isBuffer(res.Item?.obj.buff)).toEqual(true);
    expect(Buffer.isBuffer(res.Item?.arr[0].buff)).toEqual(true);
    expect(res.Item?.buff.toString('utf8')).toEqual(buff.toString('utf8'));
    expect(res.Item?.obj.buff.toString('utf8')).toEqual(buff.toString('utf8'));
    expect(res.Item?.arr[0].buff.toString('utf8')).toEqual(buff.toString('utf8'));
  });

  test('scan response', () => {
    const buff = Buffer.from('my-buffer');
    const response: Omit<ScanCommandOutput, '$metadata'> = {
      Items: [
        {
          foo: 'FOO',
          buff: new Uint8Array(buff),
        },
      ],
    };

    const res = parseResponse(response, {});

    expect(Buffer.isBuffer(res.Items?.[0]?.buff)).toEqual(true);
    expect(res.Items?.[0]?.buff.toString('utf8')).toEqual(buff.toString('utf8'));
  });

  test('batch get response', () => {
    const buff = Buffer.from('my-buffer');
    const response: Omit<BatchGetCommandOutput, '$metadata'> = {
      Responses: {
        'my-table': [
          {
            foo: 'FOO',
            buff: new Uint8Array(buff),
          },
        ],
      },
    };

    const res = parseResponse(response, {});

    expect(Buffer.isBuffer(res.Responses?.['my-table']?.[0]?.buff)).toEqual(true);
    expect(res.Responses?.['my-table']?.[0]?.buff.toString('utf8')).toEqual(buff.toString('utf8'));
  });
});
