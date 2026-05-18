import type { ScanCommandOutput } from '@aws-sdk/lib-dynamodb';
import { describe, expect, test } from 'vitest';
import { DynoReadableStream } from '../dyno-readable-stream.ts';

describe('DynoReadableStream', () => {
  test('update', () => {
    const stream = new DynoReadableStream(
      { objectMode: true },
      { TableName: 'foo', LastEvaluatedKey: { foo: 'foo' } },
    );

    expect(stream.Pages).toEqual(Number.POSITIVE_INFINITY);
    expect(stream.LastEvaluatedKey).toEqual({ foo: 'foo' });
    expect(stream.hasNextPage()).toEqual(true);
    expect(stream.isLastPage()).toEqual(false);

    const response: ScanCommandOutput = { $metadata: {} };
    stream.update(response);

    expect(stream.Count).toEqual(0);
    expect(stream.ScannedCount).toEqual(0);
    expect(stream.hasNextPage()).toEqual(false);
    expect(stream.isLastPage()).toEqual(true);
  });

  test('update - no response', () => {
    const stream = new DynoReadableStream(
      { objectMode: true },
      { TableName: 'foo', LastEvaluatedKey: { foo: 'foo' } },
    );

    expect(stream.Pages).toEqual(Number.POSITIVE_INFINITY);
    expect(stream.LastEvaluatedKey).toEqual({ foo: 'foo' });
    expect(stream.hasNextPage()).toEqual(true);
    expect(stream.isLastPage()).toEqual(false);

    stream.update();

    expect(stream.Count).toEqual(0);
    expect(stream.ScannedCount).toEqual(0);
    expect(stream.hasNextPage()).toEqual(false);
    expect(stream.isLastPage()).toEqual(true);
  });
});
