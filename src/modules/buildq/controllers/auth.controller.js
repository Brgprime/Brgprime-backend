import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

import { prisma } from '../../../config/prisma.js';
import { env } from '../../../config/env.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
// BRG Prime's own verifier, imported read-only. It is used at exactly one
// point — the door — to establish who is arriving from the other product.
import { verifyToken as verifyBrgToken } from '../../../utils/jwt.js';

import { buildqEnv } from '../config.js';
import { BuildqError } from '../lib/errors.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyBuildqToken,
  REFRESH_COOKIE,
  refreshCookieOptions,
} from '../lib/jwt.js';
import { publicUser, publicOrg } from '../lib/serialize.js';
import {
  trialEndFrom,
  serializeSubscription,
  entitlements,
} from '../services/subscription.service.js';
import { sendWelcomeEmail, sendPasswordResetEmail } from '../services/email.service.js';
import { uploadImage } from '../services/storage.service.js';

const RESET_TTL_MS = 60 * 60 * 1000; // 60 minutes

const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

function issueSession(res, user) {
  const accessToken = signAccessToken({
    userId: user.id,
    orgId: user.orgId,
    role: user.role,
    tokenVersion: user.tokenVersion,
  });
  const refreshToken = signRefreshToken({ userId: user.id, tokenVersion: user.tokenVersion });
  res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions(env.isProd));
  return { accessToken, refreshToken };
}

// The single shape every authenticated response is built from. /auth/me must
// return the subscription so the paywall is server-driven, not browser-driven.
function sessionBody(user, org, subscription, tokens) {
  return {
    user: publicUser({ ...user, org: undefined }),
    organization: publicOrg(org),
    subscription: serializeSubscription(subscription),
    entitlements: entitlements(subscription),
    ...(tokens ? { token: tokens.accessToken, refreshToken: tokens.refreshToken } : {}),
  };
}

// POST /auth/signup — creates the org, its first admin, and the 14-day trial.
export const signup = asyncHandler(async (req, res) => {
  const { name, email: address, company, password } = req.body;

  const existing = await prisma.buildqUser.findUnique({ where: { email: address } });
  if (existing) {
    throw BuildqError.conflict('An account with this email already exists.', 'email_taken');
  }

  const passwordHash = await bcrypt.hash(password, buildqEnv.bcryptRounds);
  const trialStartedAt = new Date();

  const { user, org, subscription } = await prisma.$transaction(async (tx) => {
    const org = await tx.buildqOrganization.create({ data: { name: company } });

    const user = await tx.buildqUser.create({
      data: { orgId: org.id, name, email: address, passwordHash, role: 'admin' },
    });

    const subscription = await tx.buildqSubscription.create({
      data: {
        orgId: org.id,
        status: 'trialing',
        trialStartedAt,
        trialEndsAt: trialEndFrom(trialStartedAt),
      },
    });

    await tx.buildqActivityEvent.create({
      data: { orgId: org.id, actorId: user.id, action: 'created the workspace', target: company, type: 'success' },
    });

    return { user, org, subscription };
  });

  // Delivery must not gate signup.
  sendWelcomeEmail(user.email, user.name, subscription.trialEndsAt);

  const tokens = issueSession(res, user);
  res.status(201).json(sessionBody(user, org, subscription, tokens));
});

// POST /auth/exchange — arrive from BRG Prime without signing up again.
//
// A logged-in BRG Prime user clicking through to /boq presents their BRG Prime
// access token; this trades it for a BuildQ session, creating their
// organization and 14-day trial on first visit. Everything created here is an
// ordinary BuildQ account — its own org, trial, seats and billing. BRG Prime
// pays for nothing on this side.
//
// The tokens themselves stay separate: this reads a BRG Prime token once, at
// the door, and issues a BuildQ one. It never makes a BRG Prime token valid
// against BuildQ endpoints.
export const exchange = asyncHandler(async (req, res) => {
  const { token } = req.body;

  let payload;
  try {
    payload = verifyBrgToken(token);
  } catch {
    throw BuildqError.unauthorized('That BRG Prime session is not valid.', 'invalid_brg_token');
  }
  if (payload.type && payload.type !== 'access') {
    throw BuildqError.unauthorized('A BRG Prime access token is required.', 'invalid_brg_token');
  }

  const brgUser = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!brgUser) throw BuildqError.unauthorized('That BRG Prime account no longer exists.', 'invalid_brg_token');
  if (brgUser.status === 'disabled') {
    throw BuildqError.forbidden('That BRG Prime account has been disabled.');
  }

  // The email is the identity being carried across, so it has to be one BRG
  // Prime actually proved. Without this, registering a BRG Prime account with
  // someone else's address would hand over their existing BuildQ workspace.
  if (!brgUser.emailVerified) {
    throw BuildqError.forbidden(
      'Verify your BRG Prime email address before opening BuildQ.',
      'brg_email_unverified'
    );
  }

  // Already linked — just resume.
  let user = await prisma.buildqUser.findUnique({
    where: { brgUserId: brgUser.id },
    include: { org: { include: { subscription: true } } },
  });

  let created = false;

  if (!user) {
    const byEmail = await prisma.buildqUser.findUnique({
      where: { email: brgUser.email },
      include: { org: { include: { subscription: true } } },
    });

    if (byEmail) {
      // A BuildQ account already exists on this verified address — adopt it
      // rather than refusing, so someone who signed up directly and later
      // arrives via BRG Prime lands in the workspace they already have.
      user = await prisma.buildqUser.update({
        where: { id: byEmail.id },
        data: { brgUserId: brgUser.id },
        include: { org: { include: { subscription: true } } },
      });
    } else {
      const trialStartedAt = new Date();
      // No password is set: they arrived by SSO. They can create one later
      // through the normal reset flow, which their verified email protects.
      const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), buildqEnv.bcryptRounds);

      user = await prisma.$transaction(async (tx) => {
        const org = await tx.buildqOrganization.create({ data: { name: brgUser.name } });
        const createdUser = await tx.buildqUser.create({
          data: {
            orgId: org.id,
            brgUserId: brgUser.id,
            name: brgUser.name,
            email: brgUser.email,
            phone: brgUser.phone || '',
            passwordHash: unusable,
            role: 'admin',
            emailVerified: true,
          },
        });
        await tx.buildqSubscription.create({
          data: {
            orgId: org.id,
            status: 'trialing',
            trialStartedAt,
            trialEndsAt: trialEndFrom(trialStartedAt),
          },
        });
        await tx.buildqActivityEvent.create({
          data: {
            orgId: org.id,
            actorId: createdUser.id,
            action: 'opened BuildQ from BRG Prime',
            target: org.name,
            type: 'success',
          },
        });
        return tx.buildqUser.findUnique({
          where: { id: createdUser.id },
          include: { org: { include: { subscription: true } } },
        });
      });

      created = true;
      sendWelcomeEmail(user.email, user.name, user.org.subscription.trialEndsAt);
    }
  }

  const tokens = issueSession(res, user);
  res.status(created ? 201 : 200).json({
    ...sessionBody(user, user.org, user.org.subscription, tokens),
    linkedFrom: 'brg-prime',
    created,
    // Prompts the UI to collect a company name and offer to set a password,
    // neither of which BRG Prime has.
    needsCompanyName: created,
    needsPassword: created,
  });
});

// POST /auth/login
export const login = asyncHandler(async (req, res) => {
  const { email: address, password } = req.body;

  const user = await prisma.buildqUser.findUnique({
    where: { email: address },
    include: { org: { include: { subscription: true } } },
  });

  // Same message and comparable timing whether the email or the password was
  // wrong, so this endpoint cannot be used to enumerate accounts.
  const ok = user && (await bcrypt.compare(password, user.passwordHash));
  if (!ok) {
    if (!user) await bcrypt.hash(password, buildqEnv.bcryptRounds);
    throw BuildqError.unauthorized('That email and password do not match.', 'invalid_credentials');
  }

  const updated = await prisma.buildqUser.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  const tokens = issueSession(res, updated);
  res.json(sessionBody(updated, user.org, user.org.subscription, tokens));
});

// POST /auth/refresh — rotates the pair.
export const refresh = asyncHandler(async (req, res) => {
  const raw = req.cookies?.[REFRESH_COOKIE] || req.body?.refreshToken;
  if (!raw) throw BuildqError.unauthorized('No refresh token supplied.', 'no_refresh_token');

  let payload;
  try {
    payload = verifyBuildqToken(raw, 'refresh');
  } catch {
    throw BuildqError.unauthorized('This session has expired. Please sign in again.', 'invalid_refresh_token');
  }

  const user = await prisma.buildqUser.findUnique({
    where: { id: payload.sub },
    include: { org: { include: { subscription: true } } },
  });
  if (!user || payload.tv !== user.tokenVersion) {
    throw BuildqError.unauthorized('This session has ended. Please sign in again.', 'session_ended');
  }

  const tokens = issueSession(res, user);
  res.json(sessionBody(user, user.org, user.org.subscription, tokens));
});

// POST /auth/logout — bumping tokenVersion retires every outstanding token.
export const logout = asyncHandler(async (req, res) => {
  await prisma.buildqUser.update({
    where: { id: req.buildqUser.id },
    data: { tokenVersion: { increment: 1 } },
  });
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(env.isProd));
  res.json({ ok: true });
});

// GET /auth/me
export const me = asyncHandler(async (req, res) => {
  res.json(sessionBody(req.buildqUser, req.buildqOrg, req.buildqSubscription));
});

// PATCH /auth/me
export const updateMe = asyncHandler(async (req, res) => {
  const { name, email: address, phone, company, role, photoUrl, industry, country, currency } = req.body;
  const actor = req.buildqUser;

  // A user cannot promote themselves, and only an admin renames the company.
  if (role && role !== actor.role && actor.role !== 'admin') {
    throw BuildqError.forbidden('Only a company admin can change roles.');
  }
  if (company && company !== req.buildqOrg.name && actor.role !== 'admin') {
    throw BuildqError.forbidden('Only a company admin can rename the company.');
  }
  // industry / country / currency belong to the organization, not the person.
  const orgPatch = {
    ...(industry !== undefined && { industry }),
    ...(country !== undefined && { country }),
    ...(currency !== undefined && { currency }),
  };
  if (Object.keys(orgPatch).length && actor.role !== 'admin') {
    throw BuildqError.forbidden('Only a company admin can change company settings.');
  }

  if (address && address !== actor.email) {
    const clash = await prisma.buildqUser.findUnique({ where: { email: address } });
    if (clash) throw BuildqError.conflict('That email is already in use.', 'email_taken');
  }

  const user = await prisma.buildqUser.update({
    where: { id: actor.id },
    data: {
      ...(name !== undefined && { name }),
      ...(address !== undefined && { email: address }),
      ...(phone !== undefined && { phone }),
      ...(photoUrl !== undefined && { photoUrl }),
      ...(role !== undefined && { role }),
    },
  });

  let org = req.buildqOrg;
  const orgData = {
    ...(company && company !== org.name ? { name: company } : {}),
    ...orgPatch,
  };
  if (Object.keys(orgData).length) {
    org = await prisma.buildqOrganization.update({ where: { id: org.id }, data: orgData });
  }

  res.json(sessionBody(user, org, req.buildqSubscription));
});

// POST /auth/me/photo — multipart avatar upload.
export const uploadPhoto = asyncHandler(async (req, res) => {
  if (!req.file) throw BuildqError.badRequest('Attach an image file.', { photo: 'Required.' });

  const { storageUrl } = await uploadImage(req.file, { orgId: req.buildqUser.orgId });
  const user = await prisma.buildqUser.update({
    where: { id: req.buildqUser.id },
    data: { photoUrl: storageUrl, avatar: storageUrl },
  });

  res.json({ user: publicUser(user), photoUrl: storageUrl });
});

// POST /auth/password/change
export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  const ok = await bcrypt.compare(currentPassword, req.buildqUser.passwordHash);
  if (!ok) {
    throw BuildqError.badRequest('Your current password is incorrect.', {
      currentPassword: 'Incorrect password.',
    });
  }

  const passwordHash = await bcrypt.hash(newPassword, buildqEnv.bcryptRounds);
  const user = await prisma.buildqUser.update({
    where: { id: req.buildqUser.id },
    data: { passwordHash, tokenVersion: { increment: 1 } },
  });

  // The password change invalidated the caller's own tokens too — reissue.
  const tokens = issueSession(res, user);
  res.json({ ok: true, token: tokens.accessToken, refreshToken: tokens.refreshToken });
});

// POST /auth/password/reset-request
// Always 200, whether or not the address exists — otherwise this endpoint
// becomes an account-enumeration oracle.
export const requestPasswordReset = asyncHandler(async (req, res) => {
  const { email: address } = req.body;
  const user = await prisma.buildqUser.findUnique({ where: { email: address } });

  if (user) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    await prisma.buildqUser.update({
      where: { id: user.id },
      data: {
        resetTokenHash: hashToken(rawToken),
        resetExpiresAt: new Date(Date.now() + RESET_TTL_MS),
      },
    });
    await sendPasswordResetEmail(user.email, user.name, rawToken);
  }

  res.json({ ok: true, message: 'If that email has an account, a reset link is on its way.' });
});

// POST /auth/password/reset — single use, then the token is destroyed.
export const resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;

  const user = await prisma.buildqUser.findFirst({
    where: { resetTokenHash: hashToken(token), resetExpiresAt: { gt: new Date() } },
  });
  if (!user) {
    throw BuildqError.badRequest('This reset link is invalid or has expired.', undefined, 'invalid_reset_token');
  }

  const passwordHash = await bcrypt.hash(password, buildqEnv.bcryptRounds);
  const updated = await prisma.buildqUser.update({
    where: { id: user.id },
    data: {
      passwordHash,
      resetTokenHash: null,
      resetExpiresAt: null,
      tokenVersion: { increment: 1 },
    },
  });

  const tokens = issueSession(res, updated);
  res.json({ ok: true, token: tokens.accessToken, refreshToken: tokens.refreshToken });
});
