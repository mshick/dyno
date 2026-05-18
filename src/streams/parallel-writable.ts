import { Writable, type WritableOptions } from 'node:stream';

export type ParallelWritableOptions = WritableOptions & {
  concurrency?: number;
};

export class ParallelWritable extends Writable {
  public pending: number;

  constructor({ concurrency = 5, write, final, ...writableOptions }: ParallelWritableOptions = {}) {
    super(writableOptions);

    this.setMaxListeners(Number.POSITIVE_INFINITY);
    this.pending = 0;

    if (write) {
      this._write = (chunk, enc, callback) => {
        if (this.pending >= concurrency) {
          this.once('free', () => {
            this._write(chunk, enc, callback);
          });
          return;
        }

        this.pending += 1;

        write.call(this, chunk, enc, (err) => {
          this.pending -= 1;
          if (err) {
            this.destroy(err);
          } else {
            this.emit('free');
          }
        });

        callback();
      };
    }

    if (final) {
      this._final = (callback) => {
        if (this.writableLength > 0) {
          // TODO Is this necessary, or does _final already wait for drain?
          // Wait for buffer to drain for calling final callback
          this.once('drain', () => {
            final.call(this, callback);
          });
          return;
        }

        if (this.pending) {
          // Wait for pending requests to drop below allowed concurrency
          this.on('free', () => {
            if (!this.pending) {
              final.call(this, callback);
            }
          });
          return;
        }

        final.call(this, callback);
      };
    }
  }
}
