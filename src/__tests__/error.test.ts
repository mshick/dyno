import { describe, expect, test } from 'vitest';
import { TableNameError } from '../error.ts';

describe('error', () => {
  test('TableNameError - default message', () => {
    const error = new TableNameError();
    expect(error.message).toEqual('TableName is required');
  });

  test('TableNameError - custom message', () => {
    const error = new TableNameError('no tablename');
    expect(error.message).toEqual('no tablename');
  });
});
