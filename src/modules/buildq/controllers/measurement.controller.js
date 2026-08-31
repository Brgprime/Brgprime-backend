import { prisma } from '../../../config/prisma.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { BuildqError } from '../lib/errors.js';
import { serializeMeasurement, unitForType, TYPE_COLOR } from '../lib/serializers.js';
import { normalizeUnit } from '../lib/units.js';

async function loadMeasurement(orgId, id) {
  const m = await prisma.buildqMeasurement.findFirst({
    where: { id, project: { orgId } },
    include: { document: true },
  });
  if (!m) throw BuildqError.notFound('That measurement does not exist.', 'measurement_not_found');
  return m;
}

// GET /documents/:documentId/measurements
export const listForDocument = asyncHandler(async (req, res) => {
  const rows = await prisma.buildqMeasurement.findMany({
    where: { documentId: req.document.id },
    include: { document: true },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ measurements: rows.map(serializeMeasurement) });
});

// GET /projects/:projectId/measurements
export const listForProject = asyncHandler(async (req, res) => {
  const rows = await prisma.buildqMeasurement.findMany({
    where: { projectId: req.project.id },
    include: { document: true },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ measurements: rows.map(serializeMeasurement) });
});

// POST /documents/:documentId/measurements — entered by hand on the canvas.
export const create = asyncHandler(async (req, res) => {
  const { name, type, value, unit, color } = req.body;

  if (!req.document.projectId) {
    throw BuildqError.badRequest(
      'This document is not attached to a project, so measurements cannot be recorded against it.'
    );
  }

  const measurement = await prisma.buildqMeasurement.create({
    data: {
      documentId: req.document.id,
      projectId: req.document.projectId,
      name,
      type,
      value,
      unit: unit ? normalizeUnit(unit) : unitForType(type),
      color: color || TYPE_COLOR[type] || '#1CA5F6',
      // Hand-entered: `auto` false and no confidence. A confidence score on a
      // figure a person typed would be meaningless.
      auto: false,
      confidence: null,
      createdById: req.buildqUser.id,
    },
    include: { document: true },
  });

  res.status(201).json({ measurement: serializeMeasurement(measurement) });
});

// PATCH /measurements/:measurementId
export const update = asyncHandler(async (req, res) => {
  const existing = await loadMeasurement(req.buildqUser.orgId, req.params.measurementId);
  const { name, type, value, unit, color } = req.body;

  const measurement = await prisma.buildqMeasurement.update({
    where: { id: existing.id },
    data: {
      ...(name !== undefined && { name }),
      ...(type !== undefined && { type, unit: unit ? normalizeUnit(unit) : unitForType(type) }),
      ...(value !== undefined && { value }),
      ...(unit !== undefined && { unit: normalizeUnit(unit) }),
      ...(color !== undefined && { color }),
      // Edited by a person, so it is no longer the engine's number.
      ...(value !== undefined ? { auto: false, confidence: null } : {}),
    },
    include: { document: true },
  });

  res.json({ measurement: serializeMeasurement(measurement) });
});

// DELETE /measurements/:measurementId
export const remove = asyncHandler(async (req, res) => {
  const existing = await loadMeasurement(req.buildqUser.orgId, req.params.measurementId);
  await prisma.buildqMeasurement.delete({ where: { id: existing.id } });
  res.json({ ok: true });
});
