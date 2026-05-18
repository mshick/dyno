export class TableNameError extends Error {
  constructor(message = 'TableName is required', options = {}) {
    super(message, options);
  }
}
