export class TaskError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'TaskError';
    this.code = code;
  }
}

export function errorResult(error) {
  return { code: error.code || 'TASK_FAILED', message: error.message || String(error) };
}
