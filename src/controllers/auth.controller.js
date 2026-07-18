import bcrypt from 'bcryptjs';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { signToken, signRefreshToken, verifyToken } from '../utils/jwt.js';
import { publicUser } from '../utils/serialize.js';
import { ok, created } from '../utils/respond.js';
import { features } from '../config/env.js';
import { sendOtpEmail, sendResetEmail, sendWelcomeEmail } from '../services/email.service.js';

const genOtp = () => String(Math.floor(100000 + Math.random() * 900000));
const OTP_TTL_MS = 10 * 60 * 1000;

// Only expose the code in the response when no email provider is configured
// (dev convenience) or the operator explicitly opted in.
const exposeCode = (code) =>
  !features.email && env.otpReturnInResponse ? { devOtp: code } : {};

function tokenFor(user) {
  return signToken({ sub: user.id, role: user.role });
}

function refreshFor(user) {
  return signRefreshToken({ sub: user.id });
}

// Standard auth payload returned on login / verify / reset / refresh.
const session = (user) => ({
  token: tokenFor(user),
  refreshToken: refreshFor(user),
  user: publicUser(user),
});

// POST /api/auth/register
// Creates the account (unverified), issues an OTP for the verification step.
export const register = asyncHandler(async (req, res) => {
  const { email, phone, password } = req.body;
  const name = req.body.name || `${req.body.firstName || ''} ${req.body.lastName || ''}`.trim();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw ApiError.conflict('An account with this email already exists.');

  const passwordHash = await bcrypt.hash(password, 10);
  const otp = genOtp();

  const user = await prisma.user.create({
    data: {
      name,
      email,
      phone,
      passwordHash,
      otpCode: otp,
      otpExpiresAt: new Date(Date.now() + OTP_TTL_MS),
    },
  });

  await sendOtpEmail(user.email, user.name, otp);

  return created(res, {
    email: user.email,
    requiresVerification: true,
    ...exposeCode(otp),
  }, { message: `A 6-digit code was sent to ${user.email}.` });
});

// POST /api/auth/verify-otp
// Verifies the OTP and logs the user in (returns a token).
export const verifyOtp = asyncHandler(async (req, res) => {
  const { email, code } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw ApiError.notFound('Account not found.');

  const valid =
    user.otpCode === code && user.otpExpiresAt && user.otpExpiresAt.getTime() > Date.now();
  if (!valid) throw ApiError.badRequest('Invalid or expired code.');

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { emailVerified: true, otpCode: null, otpExpiresAt: null },
  });

  sendWelcomeEmail(updated.email, updated.name);

  return ok(res, session(updated), { message: 'Account verified.' });
});

// POST /api/auth/resend-otp
export const resendOtp = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  // Do not reveal whether an account exists.
  if (!user) return ok(res, { sent: true });

  const otp = genOtp();
  await prisma.user.update({
    where: { id: user.id },
    data: { otpCode: otp, otpExpiresAt: new Date(Date.now() + OTP_TTL_MS) },
  });
  await sendOtpEmail(user.email, user.name, otp);
  return ok(res, { sent: true, ...exposeCode(otp) }, {
    message: `A new code was sent to ${email}.`,
  });
});

// POST /api/auth/login
export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw ApiError.unauthorized('Invalid email or password.');

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) throw ApiError.unauthorized('Invalid email or password.');
  if (user.status === 'disabled') throw ApiError.forbidden('This account has been disabled.');

  return ok(res, session(user), { message: 'Signed in.' });
});

// POST /api/auth/forgot-password
// Emails a 6-digit reset code. Always responds success (no account enumeration).
export const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  let code = null;
  if (user) {
    code = genOtp();
    await prisma.user.update({
      where: { id: user.id },
      data: { resetCode: code, resetExpiresAt: new Date(Date.now() + OTP_TTL_MS) },
    });
    await sendResetEmail(user.email, user.name, code);
  }
  return ok(res, { sent: true, ...(code ? exposeCode(code) : {}) }, {
    message: `If an account exists for ${email}, a reset code has been sent.`,
  });
});

// POST /api/auth/reset-password
// Consumes the reset code and sets a new password.
export const resetPassword = asyncHandler(async (req, res) => {
  const { email, code, newPassword } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw ApiError.badRequest('Invalid or expired code.');

  const valid =
    user.resetCode === code && user.resetExpiresAt && user.resetExpiresAt.getTime() > Date.now();
  if (!valid) throw ApiError.badRequest('Invalid or expired code.');

  const passwordHash = await bcrypt.hash(newPassword, 10);
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, resetCode: null, resetExpiresAt: null },
  });

  // Log them straight in after a successful reset.
  return ok(res, session(updated), { message: 'Password reset successfully.' });
});

// GET /api/auth/me
export const me = asyncHandler(async (req, res) => {
  return ok(res, { user: publicUser(req.user) });
});

// POST /api/auth/refresh — exchange a refresh token for a fresh session.
export const refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) throw ApiError.unauthorized('Missing refresh token.');

  let payload;
  try {
    payload = verifyToken(refreshToken);
  } catch {
    throw ApiError.unauthorized('Invalid or expired refresh token.');
  }
  if (payload.type !== 'refresh') throw ApiError.unauthorized('Invalid refresh token.');

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) throw ApiError.unauthorized('User no longer exists.');
  if (user.status === 'disabled') throw ApiError.forbidden('This account has been disabled.');

  // Rotate: issue a fresh access token AND a fresh refresh token.
  return ok(res, session(user), { message: 'Session refreshed.' });
});
