import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Express middleware: attaches a request id to every request/response and logs a
 * one-line access record on completion (method, path, status, duration). The id
 * flows into the error envelope and the `x-request-id` response header.
 */
export function requestContext() {
  const log = new Logger('http');
  return (req: Request & { requestId?: string }, res: Response, next: NextFunction) => {
    const id = (req.headers['x-request-id'] as string) || randomUUID();
    req.requestId = id;
    res.setHeader('x-request-id', id);
    const start = Date.now();
    res.on('finish', () => log.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`, id));
    next();
  };
}

/**
 * Consistent JSON error envelope. Preserves the status/message/error of known
 * HttpExceptions (so validation/conflict/etc. messages stay useful) but hides
 * the internals of unexpected 500s, and always adds requestId + timestamp+path.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('exception');
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { requestId?: string }>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : 500;
    const body = isHttp ? exception.getResponse() : null;

    let message: unknown = 'Internal server error';
    let error = 'InternalServerError';
    if (isHttp && body) {
      if (typeof body === 'string') message = body;
      else {
        message = (body as Record<string, unknown>).message ?? exception.message;
        error = String((body as Record<string, unknown>).error ?? exception.name);
      }
    }
    if (status >= 500) {
      this.log.error(`${req.method} ${req.url} → ${status}: ${String(exception)}`, req.requestId);
      message = 'Internal server error'; // never leak internals to clients
      error = 'InternalServerError';
    }

    res.status(status).json({
      statusCode: status,
      error,
      message,
      requestId: req.requestId,
      path: req.url,
      timestamp: new Date().toISOString(),
    });
  }
}
