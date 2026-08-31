import { prisma } from '../../../config/prisma.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { BuildqError } from '../lib/errors.js';
import { verifyBuildqToken } from '../lib/jwt.js';
import { roleCan } from '../config.js';
import { hasAccess } from '../services/subscription.service.js';
import { hasCredit } from '../services/usage.service.js';

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

// Require a valid BuildQ access token. Attaches req.buildqUser, req.buildqOrg
// and req.buildqSubscription. Deliberately named apart from BRG Prime's
// req.user so the two auth contexts can never be confused in a handler.
export const requireAuth = asyncHandler(async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) throw BuildqError.unauthorized();

  let payload;
  try {
    payload = verifyBuildqToken(token, 'access');
  } catch {
    throw BuildqError.unauthorized('Invalid or expired token.', 'invalid_token');
  }

  const user = await prisma.buildqUser.findUnique({
    where: { id: payload.sub },
    include: { org: { include: { subscription: true } } },
  });

  if (!user) throw BuildqError.unauthorized('This account no longer exists.', 'invalid_token');

  // A logout or password change bumps tokenVersion, retiring every token issued
  // before it.
  if (payload.tv !== user.tokenVersion) {
    throw BuildqError.unauthorized('This session has ended. Please sign in again.', 'session_ended');
  }

  req.buildqUser = user;
  req.buildqOrg = user.org;
  req.buildqSubscription = user.org.subscription;
  next();
});

// Gate on a named capability from the permission matrix (spec §14).
export const requirePermission = (permission) => (req, _res, next) => {
  if (!req.buildqUser) return next(BuildqError.unauthorized());
  if (!roleCan(req.buildqUser.role, permission)) {
    return next(BuildqError.forbidden(`Your role (${req.buildqUser.role}) cannot ${permission.replace(':', ' ')}.`));
  }
  next();
};

// The real paywall. The frontend modal is presentation; this is enforcement —
// an expired org gets 402 from every business endpoint regardless of what the
// browser believes.
export const requireAccess = (req, _res, next) => {
  if (!req.buildqUser) return next(BuildqError.unauthorized());
  if (!hasAccess(req.buildqSubscription)) {
    return next(BuildqError.paymentRequired());
  }
  next();
};

// Gate the endpoints that actually call Claude. The plan's AI credit allowance
// was reported by /billing/usage and enforced nowhere, so an organization could
// spend without limit on a capped plan. One credit is one paid model call.
export const requireCredits = asyncHandler(async (req, _res, next) => {
  if (!req.buildqUser) throw BuildqError.unauthorized();

  const { ok, used, limit } = await hasCredit(req.buildqUser.orgId, req.buildqSubscription);
  if (!ok) {
    throw new BuildqError(
      402,
      'ai_credits_exhausted',
      `Your plan includes ${limit} AI credits per period and ${used} have been used. Upgrade to keep analysing drawings.`
    );
  }
  next();
});
