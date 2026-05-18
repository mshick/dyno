import type { ScanCommandOutput } from '@aws-sdk/lib-dynamodb';
import type { DynoReadableStream } from './streams/dyno-readable-stream.ts';
import type { NativeAttributeMap } from './types.ts';

export async function readPaginatedStream(
  stream: DynoReadableStream,
): Promise<Omit<ScanCommandOutput, '$metadata'>> {
  return new Promise((resolve, reject) => {
    const items: NativeAttributeMap[] = [];
    stream
      .on('error', reject)
      .on('data', (item) => {
        items.push(item);
      })
      .on('end', () => {
        resolve({
          Items: items,
          Count: stream.Count,
          ScannedCount: stream.ScannedCount,
          LastEvaluatedKey: stream.LastEvaluatedKey,
          ConsumedCapacity: stream.ConsumedCapacity,
        });
      });
  });
}
