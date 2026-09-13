/**
 * Typed service errors so HTTP handlers can map to status codes without
 * brittle message matching (e.g. `message.includes('not found')`).
 */
export class NotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class ValidationError extends Error {
  constructor(message = 'Invalid value') {
    super(message);
    this.name = 'ValidationError';
  }
}
