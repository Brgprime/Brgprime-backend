import { prisma } from '../config/prisma.js';
import { verifyToken } from '../utils/jwt.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  if (req.query.token) return String(req.query.token);
  return null;
}

// Require a valid JWT; attaches req.user (full DB record).
export const requireAuth = asyncHandler(async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) throw ApiError.unauthorized('Authentication required.');

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    throw ApiError.unauthorized('Invalid or expired token.');
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) throw ApiError.unauthorized('User no longer exists.');
  if (user.status === 'disabled') throw ApiError.forbidden('This account has been disabled.');

  req.user = user;
  next();
});

// Optional auth — attaches req.user if a valid token is present, else continues.
export const optionalAuth = asyncHandler(async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) return next();
  try {
    const payload = verifyToken(token);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (user && user.status !== 'disabled') req.user = user;
  } catch {
    /* ignore invalid token for optional auth */
  }
  next();
});

// Require the authenticated user to be an admin.
export const requireAdmin = (req, _res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return next(ApiError.forbidden('Admin access required.'));
  }
  next();
};
