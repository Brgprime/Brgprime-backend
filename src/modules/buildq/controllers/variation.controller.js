import { prisma } from '../../../config/prisma.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { BuildqError } from '../lib/errors.js';
import { serializeVariation } from '../lib/serializers.js';
import { nextVariationCode } from '../lib/codes.js';
import { roleCan } from '../config.js';
import { recordActivity } from '../middleware/scope.js';

// The form collects a positive magnitude plus a direction (§8); the record
// stores it signed, negative for an omission (§6).
const signed = (impact, direction) => BigInt(Math.round(direction === 'omission' ? -impact : impact));

async function loadVariation(orgId, key) {
  const v = await prisma.buildqVariation.findFirst({
    where: { project: { orgId }, OR: [{ id: key }, { code: key }] },
    include: { raisedBy: true, decidedBy: true, project: true },
  });
  if (!v) throw BuildqError.notFound('That variation does not exist.', 'variation_not_found');
  return v;
}

// GET /projects/:projectId/variations
export const list = asyncHandler(async (req, res) => {
  const rows = await prisma.buildqVariation.findMany({
    where: { projectId: req.project.id },
    include: { raisedBy: true, decidedBy: true },
    orderBy: { raisedAt: 'desc' },
  });

  // Net approved impact = sum of impact where status === "Approved".
  const netApproved = rows
    .filter((v) => v.status === 'Approved')
    .reduce((sum, v) => sum + Number(v.impactNaira), 0);

  res.json({
    variations: rows.map(serializeVariation),
    netApproved,
    pending: rows.filter((v) => v.status === 'Pending').length,
  });
});

// POST /projects/:projectId/variations
export const create = asyncHandler(async (req, res) => {
  const { title, description, impact, direction, revisionFrom, revisionTo } = req.body;
  const code = await nextVariationCode(prisma, req.project.id);

  const variation = await prisma.buildqVariation.create({
    data: {
      projectId: req.project.id,
      code,
      title,
      description,
      impactNaira: signed(impact, direction),
      revisionFrom: revisionFrom ?? null,
      revisionTo: revisionTo ?? null,
      status: 'Pending',
      raisedById: req.buildqUser.id,
    },
    include: { raisedBy: true, decidedBy: true },
  });

  await recordActivity({
    orgId: req.buildqUser.orgId,
    projectId: req.project.id,
    actorId: req.buildqUser.id,
    action: 'raised variation',
    target: code,
    type: 'info',
  });

  res.status(201).json({ variation: serializeVariation(variation) });
});

// PATCH /variations/:variationId — including the status transition.
export const update = asyncHandler(async (req, res) => {
  const existing = await loadVariation(req.buildqUser.orgId, req.params.variationId);
  const { title, description, impact, direction, status } = req.body;

  // Re-sending the status it already has is an edit, not a decision.
  const deciding = Boolean(status) && status !== existing.status;

  // Approving or rejecting is a distinct capability from editing (§14): only
  // Admin and PM decide, and nobody decides on their own variation.
  if (deciding) {
    if (!roleCan(req.buildqUser.role, 'variations:approve')) {
      throw BuildqError.forbidden('Only a company admin or project manager can decide a variation.');
    }
    if (existing.raisedById === req.buildqUser.id) {
      throw BuildqError.forbidden('You cannot decide a variation you raised yourself.');
    }
    if (existing.status !== 'Pending') {
      throw BuildqError.conflict(
        `This variation was already ${existing.status.toLowerCase()}.`,
        'already_decided'
      );
    }
  }

  const nextImpact =
    impact !== undefined
      ? signed(impact, direction || (Number(existing.impactNaira) < 0 ? 'omission' : 'addition'))
      : undefined;

  const variation = await prisma.buildqVariation.update({
    where: { id: existing.id },
    data: {
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
      ...(nextImpact !== undefined && { impactNaira: nextImpact }),
      ...(deciding && {
        status,
        decidedById: req.buildqUser.id,
        decidedAt: new Date(),
      }),
    },
    include: { raisedBy: true, decidedBy: true },
  });

  if (deciding) {
    await recordActivity({
      orgId: req.buildqUser.orgId,
      projectId: existing.projectId,
      actorId: req.buildqUser.id,
      action: `${status.toLowerCase()} variation`,
      target: existing.code,
      type: status === 'Approved' ? 'success' : 'warning',
    });
  }

  res.json({ variation: serializeVariation(variation) });
});

// DELETE /variations/:variationId
export const remove = asyncHandler(async (req, res) => {
  const existing = await loadVariation(req.buildqUser.orgId, req.params.variationId);
  if (existing.status === 'Approved') {
    throw BuildqError.conflict(
      'An approved variation cannot be deleted — it is part of the cost record. Raise a reversing variation instead.',
      'approved_variation'
    );
  }
  await prisma.buildqVariation.delete({ where: { id: existing.id } });
  res.json({ ok: true });
});
