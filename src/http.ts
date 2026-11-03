import type { ErrorRequestHandler, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import multer from 'multer';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export const notFound = () => new HttpError(404, 'NOT_FOUND', 'Resource not found.');
export const unauthorized = () => new HttpError(401, 'UNAUTHORIZED', 'Authentication is required or invalid.');
export const idSchema = z.string().regex(/^[a-fA-F0-9]{24}$/, 'Invalid resource ID.');
export function objectId(input: unknown): ObjectId { return new ObjectId(idSchema.parse(input)); }

export const requestIdentity: RequestHandler = (_req, res, next) => {
  res.locals.requestId = randomUUID();
  res.setHeader('X-Request-Id', res.locals.requestId);
  next();
};

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (res.headersSent) return next(error);
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'An unexpected error occurred.';
  let fields: Record<string, string> | undefined;
  if (error instanceof HttpError) {
    ({ status, code, message } = error);
  } else if (error instanceof z.ZodError) {
    status = 400; code = 'VALIDATION_ERROR'; message = 'One or more fields are invalid.';
    fields = Object.fromEntries(error.issues.map(issue => [issue.path.join('.') || 'body', issue.message]));
  } else if (error instanceof multer.MulterError) {
    status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    code = status === 413 ? 'UPLOAD_TOO_LARGE' : 'INVALID_UPLOAD'; message = 'Upload rejected.';
  } else if (error instanceof Error && 'code' in error && error.code === 11000) {
    status = 409; code = 'CONFLICT'; message = 'The resource conflicts with an existing record.';
  } else if (error instanceof Error && 'type' in error && error.type === 'entity.parse.failed') {
    status = 400; code = 'INVALID_JSON'; message = 'The request body must be valid JSON.';
  } else if (error instanceof Error && 'type' in error && error.type === 'entity.too.large') {
    status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'Request body is too large.';
  }
  if (status === 500) console.error(JSON.stringify({ event: 'request_failed', requestId: res.locals.requestId }));
  res.status(status).type('application/json').json({ error: { code, message, ...(fields ? { fields } : {}), requestId: res.locals.requestId } });
};
