import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import range from 'lodash/range.js';
import { describe, expect, test } from 'vitest';
import { ParallelWritable } from '../parallel-writable.ts';

function timedWriter(pauseTime: number, error?: Error) {
  const state: {
    buffer: any[];
    data: any[];
    stop: boolean;
    running: number;
    error?: Error;
  } = {
    buffer: [],
    data: [],
    error: undefined,
    stop: false,
    running: 0,
  };

  function work(callback: (error?: Error | null) => void) {
    if (error ?? state.error) {
      callback(error ?? state.error);
      return;
    }

    while (state.buffer.length) {
      const chunk = state.buffer.shift();
      state.data.push(chunk);
    }

    callback();

    state.running -= 1;
  }

  function write(chunk: any, _enc: unknown, callback: (error?: Error | null) => void) {
    state.buffer.push(chunk);

    state.running += 1;

    if (pauseTime) {
      setTimeout(work, pauseTime, callback);
    } else {
      work(callback);
    }
  }

  function final(callback: (error?: Error | null) => void) {
    state.stop = true;

    if (!state.buffer.length) {
      callback();
      return;
    }

    work(callback);
  }

  return {
    write,
    final,
    state,
  };
}

function timedReader(pauseTime: number) {
  const state = {
    count: 0,
    stop: false,
  };

  function read() {
    setTimeout(() => {
      if (!state.stop) {
        state.count += 1;
        readable.push(state.count.toString());
      }
    }, pauseTime);
  }

  const readable = new Readable({ read, objectMode: true });

  readable.on('stop', () => {
    state.stop = true;
    readable.push(null);
  });

  return {
    readable,
    state,
  };
}

function getRange({ count }: { count: number }) {
  return range(1, count + 1).map((num) => num.toString());
}

describe('ParallelWritable', () => {
  const concurrency = 10;

  test('passes through stream options', () => {
    const writer = timedWriter(30);
    const writable = new ParallelWritable({
      write: writer.write,
      final: writer.final,
      concurrency,
      objectMode: true,
    });

    expect(() => {
      writable.write({ one: 1 });
      writable.end();
    }).not.toThrow();
  });

  test('handles writer error', async () => {
    const error = new Error('processing failed');

    const writer = timedWriter(30, error);
    const reader = timedReader(20);

    setTimeout(() => {
      reader.readable.emit('stop');
    }, 2000);

    const writable = new ParallelWritable({
      write: writer.write,
      final: writer.final,
      concurrency,
      objectMode: true,
    });

    await expect(async () => pipeline(reader.readable, writable)).rejects.toThrow(error);
  });

  test('handles writer error after .end() is called', async () => {
    const error = new Error('processing failed');

    const writer = timedWriter(30);
    const reader = timedReader(20);

    reader.readable.on('end', () => {
      writer.state.error = error;
    });

    setTimeout(() => {
      reader.readable.emit('stop');
    }, 2000);

    const writable = new ParallelWritable({
      write: writer.write,
      final: writer.final,
      concurrency,
      objectMode: true,
    });

    await expect(pipeline(reader.readable, writable)).rejects.toThrow(error);
  });

  test('accepts chunks on .end()', () => {
    const writer = timedWriter(30);
    const writable = new ParallelWritable({
      write: writer.write,
      final: writer.final,
      concurrency,
      objectMode: true,
    });

    writable.end('42');

    writable.on('finish', () => {
      expect(writer.state.data).toEqual(['42']);
    });
  });

  test('accepts callback on .end()', () => {
    const writer = timedWriter(30);
    const writable = new ParallelWritable({
      write: writer.write,
      final: writer.final,
      concurrency,
      objectMode: true,
    });
    writable.end((err: Error) => {
      expect(err).toBeFalsy();
    });
  });

  test('accepts chunk and callback on .end()', () => {
    const writer = timedWriter(30);
    const writable = new ParallelWritable({
      write: writer.write,
      final: writer.final,
      concurrency,
      objectMode: true,
    });

    writable.end('42', () => {
      expect(writer.state.data).toEqual(['42']);
    });
  });

  test('accepts chunk, enc and callback on .end()', () => {
    const writer = timedWriter(30);
    const writable = new ParallelWritable({
      write: writer.write,
      final: writer.final,
      concurrency,
      objectMode: true,
    });

    writable.end('42', 'utf-8', () => {
      expect(writer.state.data).toEqual(['42']);
    });
  });

  test('synchronous writer', async () => {
    const error = new Error('post .end() failure');

    const writer = timedWriter(0);
    const reader = timedReader(20);

    reader.readable.on('end', () => {
      writer.state.error = error;
    });

    setTimeout(() => {
      reader.readable.emit('stop');
    }, 2000);

    const writable = new ParallelWritable({
      write: writer.write,
      final: writer.final,
      concurrency,
      objectMode: true,
    });

    await pipeline(reader.readable, writable);

    expect(writer.state.data).toEqual(getRange(reader.state));
  });
});

describe.each([1, 10, 100])('ParallelWritable [concurrency: %i]', (concurrency) => {
  test('maintains desired concurrency', async () => {
    const writer = timedWriter(30);
    const reader = timedReader(20);

    setTimeout(() => {
      reader.readable.emit('stop');
    }, 2000);

    const writable = new ParallelWritable({
      write: writer.write,
      final: writer.final,
      concurrency,
      objectMode: true,
    });

    const interval = setInterval(() => {
      expect(writer.state.running).toBeLessThanOrEqual(concurrency);
    }, 5);

    await pipeline(reader.readable, writable);
    clearInterval(interval);
    expect(writer.state.data).toEqual(getRange(reader.state));
  });
});
