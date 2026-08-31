import { env } from '../../../config/env.js';

// ─────────────────────────────────────────────────────────────────────────────
// BuildQ uses its own error envelope (spec §11):
//
//   { "error": { "code": "string", "message": "human readable", "fields": {} } }
//
// BRG Prime uses { success: false, error: { message } }. Rather than change the
// shared error handler, BuildQ mounts its own at the end of its router, so the
// two products can disagree about response shape without touching each other.
// ─────────────────────────────────────────────────────────────────────────────

export class BuildqError extends Error {
  constructor(statusCode, code, message, fields = undefined) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.fields = fields;
    this.isOperational = true;
  }

  static badRequest(message = 'Bad request', fields, code = 'bad_request') {
    return new BuildqError(400, code, message, fields);
  }
  static validation(message = 'Validation failed.', fields) {
    return new BuildqError(422, 'validation_failed', message, fields);
  }
  static unauthorized(message = 'Authentication required.', code = 'unauthorized') {
    return new BuildqError(401, code, message);
  }
  static forbidden(message = 'You do not have permission to do that.', code = 'forbidden') {
    return new BuildqError(403, code, message);
  }
  static paymentRequired(message = 'Your trial has ended. Choose a plan to continue.') {
    return new BuildqError(402, 'subscription_required', message);
  }
  static notFound(message = 'Not found.', code = 'not_found') {
    return new BuildqError(404, code, message);
  }
  static conflict(message = 'Conflict.', code = 'conflict') {
    return new BuildqError(409, code, message);
  }
  static unavailable(message = 'Service unavailable.', code = 'unavailable') {
    return new BuildqError(503, code, message);
  }
}

// 404 for unmatched routes under the BuildQ mount point.
export const buildqNotFound = (req, _res, next) => {
  next(BuildqError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
};

// Router-scoped error handler. Terminates the request — it never delegates to
// the BRG Prime handler, so BuildQ responses always carry the BuildQ envelope.
// eslint-disable-next-line no-unused-vars
export const buildqErrorHandler = (err, _req, res, _next) => {
  let statusCode = err.statusCode || 500;
  let code = err.code || 'internal_error';
  let message = err.message || 'Internal server error';
  const fields = err.fields;

  // BuildQ reuses BRG Prime's services (Paystack, Cloudinary), which throw its
  // ApiError — a shape with a statusCode but no machine-readable code. Left
  // alone those surface as "internal_error" with a 4xx/503 status, which tells
  // a client nothing. Map them onto a code derived from the status instead.
  if (!err.code && err.isOperational && typeof err.statusCode === 'number') {
    code =
      {
        400: 'bad_request',
        401: 'unauthorized',
        403: 'forbidden',
        404: 'not_found',
        409: 'conflict',
        503: 'service_unavailable',
      }[err.statusCode] || 'error';
  }

  // Prisma known errors → friendly messages.
  if (err.code === 'P2002') {
    statusCode = 409;
    code = 'already_exists';
    const target = err.meta?.target;
    message = `A record with this ${Array.isArray(target) ? target.join(', ') : target || 'value'} already exists.`;
  } else if (err.code === 'P2025') {
    statusCode = 404;
    code = 'not_found';
    message = 'Record not found.';
  }

  if (statusCode >= 500) {
    if (env.isProd) {
      console.error(`[buildq] ${err.name}: ${err.message}`);
      code = 'internal_error';
      message = 'Internal server error';
    } else {
      console.error('[buildq]', err);
    }
  }

  res.status(statusCode).json({
    error: { code, message, ...(fields ? { fields } : {}) },
  });
};
