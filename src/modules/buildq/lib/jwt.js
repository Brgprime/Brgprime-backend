import jwt from 'jsonwebtoken';
import { buildqEnv } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────
// BuildQ tokens are signed with a key derived from — but not equal to — the
// BRG Prime JWT secret, and carry aud/iss claims that are verified on every
// request. A BRG Prime token therefore cannot authenticate a BuildQ request,
// and a BuildQ token cannot authenticate a BRG Prime one. The two products
// share a process and a database, never a session.
// ─────────────────────────────────────────────────────────────────────────────

const base = {
  issuer: buildqEnv.jwtIssuer,
  audience: buildqEnv.jwtAudience,
};

export function signAccessToken({ userId, orgId, role, tokenVersion }) {
  return jwt.sign(
    { sub: userId, org: orgId, role, tv: tokenVersion, typ: 'access' },
    buildqEnv.jwtSecret,
    { ...base, expiresIn: buildqEnv.accessExpiresIn }
  );
}

export function signRefreshToken({ userId, tokenVersion }) {
  return jwt.sign({ sub: userId, tv: tokenVersion, typ: 'refresh' }, buildqEnv.jwtSecret, {
    ...base,
    expiresIn: buildqEnv.refreshExpiresIn,
  });
}

// A short-lived token that authorises reading ONE document's bytes inline.
//
// WHY: a preview has to be reachable from <img src> and <iframe src>, and
// neither can carry an Authorization header. The refresh cookie is scoped to
// /api/buildq/auth so it is not sent either. Rather than hand the browser a
// Cloudinary URL — which arrives as Content-Disposition: attachment and so
// downloads instead of rendering — the API streams the bytes itself, gated by
// this token. It names one document, expires in five minutes, and cannot be
// used as an access token because of its typ claim.
export function signFileToken({ documentId, orgId }) {
  return jwt.sign({ sub: documentId, org: orgId, typ: 'file' }, buildqEnv.jwtSecret, {
    ...base,
    expiresIn: '5m',
  });
}

// Throws on an invalid/expired token, or one minted for the other product.
export function verifyBuildqToken(token, expectedType = 'access') {
  const payload = jwt.verify(token, buildqEnv.jwtSecret, base);
  if (payload.typ !== expectedType) {
    throw new Error(`Expected a ${expectedType} token.`);
  }
  return payload;
}

// Refresh tokens go in an httpOnly cookie (spec §14).
export const REFRESH_COOKIE = 'buildq_refresh';

export function refreshCookieOptions(isProd) {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/api/buildq/auth',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  };
}
