import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

import { prisma } from '../../../config/prisma.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { BuildqError } from '../lib/errors.js';
import { initials } from '../lib/serializers.js';
import { buildqEnv, ROLES } from '../config.js';
import { entitlements } from '../services/subscription.service.js';
import { sendTeamInviteEmail } from '../services/email.service.js';
import { recordActivity } from '../middleware/scope.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

const ROLE_LABELS = {
  admin: 'Company Admin',
  qs: 'Quantity Surveyor',
  pm: 'Project Manager',
  client_viewer: 'Client Viewer',
};

const memberShape = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: ROLE_LABELS[u.role] || u.role,
  roleSlug: u.role,
  avatar: initials(u.name),
  status: 'Active',
  online: false, // presence is not tracked; reporting it as false beats faking it
  lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
});

const inviteShape = (i) => ({
  id: i.id,
  name: i.name,
  email: i.email,
  role: ROLE_LABELS[i.role] || i.role,
  roleSlug: i.role,
  avatar: initials(i.name || i.email),
  status: 'Invited',
  online: false,
  expiresAt: i.expiresAt.toISOString(),
});

// GET /team
export const list = asyncHandler(async (req, res) => {
  const orgId = req.buildqUser.orgId;
  const [members, invitations] = await Promise.all([
    prisma.buildqUser.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } }),
    prisma.buildqTeamInvitation.findMany({
      where: { orgId, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const ent = entitlements(req.buildqSubscription);
  const used = members.length + invitations.length;

  const byRole = {};
  for (const m of members) byRole[m.role] = (byRole[m.role] || 0) + 1;

  res.json({
    // One list, as the screen renders it — active members and pending invites.
    team: [...members.map(memberShape), ...invitations.map(inviteShape)],
    counts: Object.fromEntries(ROLES.map((r) => [r, byRole[r] || 0])),
    seats: { used, limit: ent.seats, remaining: ent.seats === null ? null : Math.max(0, ent.seats - used) },
  });
});

// POST /team/invitations
export const invite = asyncHandler(async (req, res) => {
  const orgId = req.buildqUser.orgId;
  const { name, email, role } = req.body;

  const [existingUser, existingInvite, memberCount, inviteCount] = await Promise.all([
    prisma.buildqUser.findUnique({ where: { email } }),
    prisma.buildqTeamInvitation.findFirst({ where: { orgId, email, status: 'pending' } }),
    prisma.buildqUser.count({ where: { orgId } }),
    prisma.buildqTeamInvitation.count({ where: { orgId, status: 'pending' } }),
  ]);

  // Someone who already has a BuildQ account can be invited: they accept by
  // signing in rather than by signing up. Only being on THIS team is a clash.
  if (existingUser && existingUser.orgId === orgId) {
    throw BuildqError.conflict('That person is already on your team.', 'already_a_member');
  }
  if (existingInvite) {
    throw BuildqError.conflict('That email already has a pending invitation.', 'already_invited');
  }

  // Seats are a paid entitlement, so the limit is enforced here rather than
  // only shown in the UI.
  const ent = entitlements(req.buildqSubscription);
  if (ent.seats !== null && memberCount + inviteCount >= ent.seats) {
    throw BuildqError.paymentRequired(
      `Your plan includes ${ent.seats} seats and they are all taken. Upgrade to invite more people.`
    );
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const invitation = await prisma.buildqTeamInvitation.create({
    data: {
      orgId,
      email,
      name: name || '',
      role,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });

  await sendTeamInviteEmail(email, {
    inviterName: req.buildqUser.name,
    orgName: req.buildqOrg.name,
    role: ROLE_LABELS[role] || role,
    token: rawToken,
  });

  await recordActivity({
    orgId,
    actorId: req.buildqUser.id,
    action: 'invited',
    target: email,
    type: 'info',
  });

  res.status(201).json({ invitation: inviteShape(invitation) });
});

// POST /team/invitations/:invitationId/resend
export const resend = asyncHandler(async (req, res) => {
  const invitation = await prisma.buildqTeamInvitation.findFirst({
    where: { id: req.params.invitationId, orgId: req.buildqUser.orgId, status: 'pending' },
  });
  if (!invitation) throw BuildqError.notFound('That invitation does not exist.', 'invite_not_found');

  // A fresh token — the old one stops working, so a forwarded email cannot be
  // replayed after a resend.
  const rawToken = crypto.randomBytes(32).toString('hex');
  const updated = await prisma.buildqTeamInvitation.update({
    where: { id: invitation.id },
    data: { tokenHash: hashToken(rawToken), expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
  });

  await sendTeamInviteEmail(invitation.email, {
    inviterName: req.buildqUser.name,
    orgName: req.buildqOrg.name,
    role: ROLE_LABELS[invitation.role] || invitation.role,
    token: rawToken,
  });

  res.json({ invitation: inviteShape(updated) });
});

// DELETE /team/invitations/:invitationId
export const revoke = asyncHandler(async (req, res) => {
  const invitation = await prisma.buildqTeamInvitation.findFirst({
    where: { id: req.params.invitationId, orgId: req.buildqUser.orgId },
  });
  if (!invitation) throw BuildqError.notFound('That invitation does not exist.', 'invite_not_found');
  await prisma.buildqTeamInvitation.update({
    where: { id: invitation.id },
    data: { status: 'revoked' },
  });
  res.json({ ok: true });
});

// POST /team/invitations/lookup — public.
// Tells the holder of an invitation link what they are being asked to join and,
// crucially, WHICH form to show them: create an account, or sign in with the
// one they already have. The token was emailed to this address, so telling its
// holder whether that address has an account reveals nothing they were not
// already told.
export const lookupInvitation = asyncHandler(async (req, res) => {
  const { token } = req.body;

  const invitation = await prisma.buildqTeamInvitation.findFirst({
    where: { tokenHash: hashToken(token), status: 'pending', expiresAt: { gt: new Date() } },
    include: { org: true },
  });
  if (!invitation) {
    throw BuildqError.badRequest(
      'This invitation is invalid, has expired, or has already been used.',
      undefined,
      'invalid_invitation'
    );
  }

  const existing = await prisma.buildqUser.findUnique({
    where: { email: invitation.email },
    select: { id: true, orgId: true },
  });

  res.json({
    email: invitation.email,
    name: invitation.name || '',
    organization: invitation.org.name,
    role: ROLE_LABELS[invitation.role] || invitation.role,
    roleSlug: invitation.role,
    expiresAt: invitation.expiresAt.toISOString(),
    // Which half of the flow the invitee is in.
    hasAccount: Boolean(existing),
    alreadyAMember: Boolean(existing && existing.orgId === invitation.orgId),
  });
});

// POST /team/invitations/accept — public.
//
// Two ways in, matching how the invitee actually arrives:
//
//   no account yet   send `password` (and optionally `name`) — the account is
//                    created in the inviting organization.
//   already has one  send `password` for THAT account — it is verified, and the
//                    person is moved into the inviting organization.
//
// A BuildQ user belongs to exactly one organization, so the second path is a
// MOVE, not a second membership. That is safe for someone who signed up, looked
// around and is now being added to a company; it is not safe for someone with a
// real workspace of their own, so that case is refused rather than quietly
// stranding their projects.
export const accept = asyncHandler(async (req, res) => {
  const { token, name, password } = req.body;

  const invitation = await prisma.buildqTeamInvitation.findFirst({
    where: { tokenHash: hashToken(token), status: 'pending', expiresAt: { gt: new Date() } },
    include: { org: true },
  });
  if (!invitation) {
    throw BuildqError.badRequest(
      'This invitation is invalid, has expired, or has already been used.',
      undefined,
      'invalid_invitation'
    );
  }

  const existing = await prisma.buildqUser.findUnique({ where: { email: invitation.email } });

  // ── Already has an account: verify it, then move them across ──────────────
  if (existing) {
    if (existing.orgId === invitation.orgId) {
      await prisma.buildqTeamInvitation.update({
        where: { id: invitation.id },
        data: { status: 'accepted' },
      });
      return res.json({ ok: true, joined: true, email: existing.email, message: 'You are already on this team.' });
    }

    // The password proves this is really them; the emailed token alone only
    // proves someone read the invitation.
    const ok = await bcrypt.compare(password, existing.passwordHash);
    if (!ok) {
      throw BuildqError.unauthorized(
        'That password does not match the existing account for this email.',
        'invalid_credentials'
      );
    }

    const [siblings, projectCount] = await Promise.all([
      prisma.buildqUser.count({ where: { orgId: existing.orgId, id: { not: existing.id } } }),
      prisma.buildqProject.count({ where: { orgId: existing.orgId } }),
    ]);

    if (siblings > 0 || projectCount > 0) {
      throw BuildqError.conflict(
        'This email already runs its own BuildQ workspace, and an account can only belong to one organization. ' +
          'Ask to be invited on a different address, or move that workspace first.',
        'already_has_workspace'
      );
    }

    const oldOrgId = existing.orgId;

    const moved = await prisma.$transaction(async (tx) => {
      const updated = await tx.buildqUser.update({
        where: { id: existing.id },
        data: {
          orgId: invitation.orgId,
          role: invitation.role,
          ...(name ? { name } : {}),
          // Joining ends every session held against the old organization.
          tokenVersion: { increment: 1 },
        },
      });
      await tx.buildqTeamInvitation.update({
        where: { id: invitation.id },
        data: { status: 'accepted' },
      });
      // Their old workspace is empty by the check above, so it is removed
      // rather than left as an orphan nobody can reach.
      await tx.buildqOrganization.delete({ where: { id: oldOrgId } }).catch(() => {});
      return updated;
    });

    await recordActivity({
      orgId: invitation.orgId,
      actorId: moved.id,
      action: 'joined',
      target: invitation.org.name,
      type: 'success',
    });

    return res.json({
      ok: true,
      joined: true,
      email: moved.email,
      organization: invitation.org.name,
      message: `You have joined ${invitation.org.name}. Sign in to continue.`,
    });
  }

  // ── No account yet: create one in the inviting organization ───────────────
  const passwordHash = await bcrypt.hash(password, buildqEnv.bcryptRounds);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.buildqUser.create({
      data: {
        orgId: invitation.orgId,
        name: name || invitation.name || invitation.email.split('@')[0],
        email: invitation.email,
        passwordHash,
        role: invitation.role,
        emailVerified: true, // they proved control of the address by using the link
      },
    });
    await tx.buildqTeamInvitation.update({
      where: { id: invitation.id },
      data: { status: 'accepted' },
    });
    return created;
  });

  await recordActivity({
    orgId: invitation.orgId,
    actorId: user.id,
    action: 'joined',
    target: invitation.org.name,
    type: 'success',
  });

  res.status(201).json({
    ok: true,
    created: true,
    message: 'Your account is ready. Sign in to continue.',
    email: user.email,
    organization: invitation.org.name,
  });
});

// PATCH /team/members/:memberId — change role.
export const updateMember = asyncHandler(async (req, res) => {
  const orgId = req.buildqUser.orgId;
  const { role } = req.body;

  const member = await prisma.buildqUser.findFirst({ where: { id: req.params.memberId, orgId } });
  if (!member) throw BuildqError.notFound('That team member does not exist.', 'member_not_found');

  // An organization must keep at least one admin, or nobody can manage billing
  // or the team again.
  if (member.role === 'admin' && role !== 'admin') {
    const admins = await prisma.buildqUser.count({ where: { orgId, role: 'admin' } });
    if (admins <= 1) {
      throw BuildqError.conflict(
        'This is the only company admin. Promote someone else first.',
        'last_admin'
      );
    }
  }

  const updated = await prisma.buildqUser.update({
    where: { id: member.id },
    // A role change must retire their existing tokens, or the old permissions
    // stay live until the access token happens to expire.
    data: { role, tokenVersion: { increment: 1 } },
  });

  res.json({ member: memberShape(updated) });
});

// DELETE /team/members/:memberId
export const removeMember = asyncHandler(async (req, res) => {
  const orgId = req.buildqUser.orgId;
  const member = await prisma.buildqUser.findFirst({ where: { id: req.params.memberId, orgId } });
  if (!member) throw BuildqError.notFound('That team member does not exist.', 'member_not_found');

  if (member.id === req.buildqUser.id) {
    throw BuildqError.conflict('You cannot remove yourself from the team.', 'self_removal');
  }
  if (member.role === 'admin') {
    const admins = await prisma.buildqUser.count({ where: { orgId, role: 'admin' } });
    if (admins <= 1) {
      throw BuildqError.conflict('The company admin cannot be removed.', 'last_admin');
    }
  }

  await prisma.buildqUser.delete({ where: { id: member.id } });

  await recordActivity({
    orgId,
    actorId: req.buildqUser.id,
    action: 'removed',
    target: member.name,
    type: 'warning',
  });

  res.json({ ok: true });
});
