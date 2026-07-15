import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';

// 404 handler for unmatched routes.
export const notFound = (req, _res, next) => {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
};

// Centralised error handler.
// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, _req, res, _next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal server error';
  let details = err.details;

  // Prisma known errors → friendly messages.
  if (err.code === 'P2002') {
    statusCode = 409;
    message = `A record with this ${err.meta?.target || 'value'} already exists.`;
  } else if (err.code === 'P2025') {
    statusCode = 404;
    message = 'Record not found.';
  }

  if (statusCode >= 500 && !env.isProd) {
    // Surface stack in dev only.
    console.error(err);
  } else if (statusCode >= 500) {
    console.error(`${err.name}: ${err.message}`);
    message = 'Internal server error';
  }

  res.status(statusCode).json({
    success: false,
    error: { message, ...(details ? { details } : {}) },
  });
};
