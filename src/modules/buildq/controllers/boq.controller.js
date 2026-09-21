import { prisma } from '../../../config/prisma.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { BuildqError } from '../lib/errors.js';
import { serializeBoqItem, serializeBoqRevision } from '../lib/serializers.js';
import { normalizeUnit, sameDimension, violatesConvention } from '../lib/units.js';
import { SECTION_ORDER } from '../lib/codes.js';
import { recordActivity } from '../middleware/scope.js';
import {
  currentItems,
  currentRevision,
  createRevision,
  resequence,
  totals,
  itemsFromMeasurements,
} from '../services/boq.service.js';

// Loads a BOQ item and proves it belongs to the caller's organization.
async function loadItem(orgId, itemId) {
  const item = await prisma.buildqBoqItem.findFirst({
    where: { id: itemId, project: { orgId } },
    include: { project: true },
  });
  if (!item) throw BuildqError.notFound('That BOQ item does not exist.', 'item_not_found');
  return item;
}

// A description and unit that disagree with §9 is a warning, not a rejection —
// a QS may have a reason. But it is never silent.
function conventionWarning(desc, unit) {
  const clash = violatesConvention(desc, unit);
  if (!clash) return null;
  return {
    type: 'warning',
    text: `"${desc}" is normally billed in ${clash.expected}, not ${clash.actual}.`,
  };
}

// GET /projects/:projectId/boq
export const get = asyncHandler(async (req, res) => {
  const { revision, items } = await currentItems(req.project.id);
  const { sections, total } = totals(items);

  const warnings = [];
  for (const i of items) {
    const w = conventionWarning(i.description, i.unit);
    if (w) warnings.push(w);
  }

  res.json({
    revision: serializeBoqRevision(revision),
    items: items.map(serializeBoqItem),
    sections,
    total,
    // Provenance the header badge reads: "Analyzed" vs "Template estimate".
    source: revision?.source ?? null,
    notes: [...(revision?.notes || []), ...warnings],
  });
});

// GET /projects/:projectId/boq/revisions
export const revisions = asyncHandler(async (req, res) => {
  const rows = await prisma.buildqBoqRevision.findMany({
    where: { projectId: req.project.id },
    include: { createdBy: true, _count: { select: { items: true } } },
    orderBy: { version: 'desc' },
  });
  res.json({ revisions: rows.map(serializeBoqRevision) });
});

// POST /projects/:projectId/boq/items
export const addItem = asyncHandler(async (req, res) => {
  const { desc, section, unit, qty, rate, sources, basis, assumption } = req.body;
  const normalized = normalizeUnit(unit);

  let revision = await currentRevision(req.project.id);
  if (!revision) {
    revision = await createRevision(req.project.id, [], {
      source: 'manual',
      createdById: req.buildqUser.id,
    });
  }

  // An unknown section sorts last and gets code letter "H", which is not what
  // anyone typing a section name expects. Reject it here rather than quietly
  // filing the line outside the bill order.
  if (!SECTION_ORDER.includes(section)) {
    throw BuildqError.validation('Choose a valid bill section.', {
      section: `Must be one of: ${SECTION_ORDER.join(', ')}.`,
    });
  }

  const count = await prisma.buildqBoqItem.count({ where: { revisionId: revision.id } });
  const row = await prisma.buildqBoqItem.create({
    data: {
      revisionId: revision.id,
      projectId: req.project.id,
      description: desc,
      section,
      unit: normalized,
      qty,
      rate,
      // Nothing here carries a confidence. A typed figure has nothing to be
      // confident about, and an accepted proposal was reviewed by a person
      // rather than measured afresh — so the line records HOW it was arrived at
      // and the rule behind it, which is checkable, instead of a score which is
      // not.
      confidence: null,
      basis: basis || 'manual',
      assumption: basis && basis !== 'manual' ? assumption || null : null,
      sources,
      sortOrder: count,
    },
  });

  // Match on the id, not on description + qty — two identical lines are legal
  // in a bill, and matching on their text returned whichever came first.
  const ordered = await resequence(revision.id);
  const created = ordered.find((i) => i.id === row.id) ?? row;

  await recordActivity({
    orgId: req.buildqUser.orgId,
    projectId: req.project.id,
    actorId: req.buildqUser.id,
    action: 'added BOQ item',
    target: desc,
    type: 'edit',
  });

  const warning = conventionWarning(desc, normalized);
  res.status(201).json({
    item: serializeBoqItem(created),
    ...(warning ? { notes: [warning] } : {}),
  });
});

// PATCH /boq/items/:itemId
export const updateItem = asyncHandler(async (req, res) => {
  const existing = await loadItem(req.buildqUser.orgId, req.params.itemId);
  const { desc, section, unit, qty, rate } = req.body;

  const notes = [];
  let normalized = existing.unit;

  if (unit !== undefined) {
    normalized = normalizeUnit(unit);
    // The dimensional check the frontend performs, enforced here too: changing
    // m³ to m² silently revalues the line by the slab thickness.
    if (!sameDimension(existing.unit, normalized)) {
      notes.push({
        type: 'warning',
        text: `Unit changed from ${existing.unit} to ${normalized}, which measures a different dimension. The rate of ₦${existing.rate.toLocaleString()} per ${existing.unit} may no longer apply.`,
      });
    }
  }

  const item = await prisma.buildqBoqItem.update({
    where: { id: existing.id },
    data: {
      ...(desc !== undefined && { description: desc }),
      ...(section !== undefined && { section }),
      ...(unit !== undefined && { unit: normalized }),
      ...(qty !== undefined && { qty }),
      ...(rate !== undefined && { rate }),
      // Any hand edit invalidates a machine confidence — it is no longer the
      // engine's figure, and neither its basis nor its assumption still
      // describes the number that is now there.
      ...(qty !== undefined || unit !== undefined
        ? { confidence: null, basis: 'manual', assumption: null }
        : {}),
    },
  });

  if (section !== undefined) await resequence(existing.revisionId);

  const w = conventionWarning(item.description, item.unit);
  if (w) notes.push(w);

  res.json({ item: serializeBoqItem(item), ...(notes.length ? { notes } : {}) });
});

// DELETE /boq/items/:itemId
export const deleteItem = asyncHandler(async (req, res) => {
  const existing = await loadItem(req.buildqUser.orgId, req.params.itemId);
  await prisma.buildqBoqItem.delete({ where: { id: existing.id } });
  await resequence(existing.revisionId);
  res.json({ ok: true });
});

// POST /projects/:projectId/boq/import — from takeoff measurements.
export const importFromTakeoff = asyncHandler(async (req, res) => {
  const { measurementIds, region } = req.body;

  const measurements = await prisma.buildqMeasurement.findMany({
    where: {
      projectId: req.project.id,
      ...(measurementIds?.length ? { id: { in: measurementIds } } : {}),
    },
    include: { document: true },
  });

  if (!measurements.length) {
    throw BuildqError.badRequest('There are no measurements to import.', undefined, 'nothing_to_import');
  }

  const { items, skipped } = await itemsFromMeasurements(measurements, {
    orgId: req.buildqUser.orgId,
    region,
  });

  if (!items.length) {
    throw BuildqError.badRequest(
      'None of the selected measurements could be priced.',
      undefined,
      'nothing_to_import'
    );
  }

  const existing = await currentItems(req.project.id);
  const revision = await createRevision(req.project.id, [...existing.items, ...items], {
    source: existing.revision?.source === 'engine' ? 'engine' : 'manual',
    region,
    createdById: req.buildqUser.id,
    generatedFrom: [...new Set(measurements.map((m) => m.documentId).filter(Boolean))],
    notes: skipped.map((s) => ({ type: 'warning', text: `Skipped "${s.name}" — ${s.reason}.` })),
  });

  await recordActivity({
    orgId: req.buildqUser.orgId,
    projectId: req.project.id,
    actorId: req.buildqUser.id,
    action: 'imported measurements into BOQ',
    target: `${items.length} item(s)`,
    type: 'edit',
  });

  res.status(201).json({
    revision: serializeBoqRevision(revision),
    imported: items.length,
    skipped,
  });
});

// GET /projects/:projectId/boq/export?format=csv
export const exportBoq = asyncHandler(async (req, res) => {
  const format = String(req.query.format || 'csv').toLowerCase();
  if (format !== 'csv') {
    throw BuildqError.badRequest(
      `Export format "${format}" is not available yet. Only csv is implemented.`,
      undefined,
      'unsupported_format'
    );
  }

  const { items } = await currentItems(req.project.id);
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  // Basis and assumption travel with the export: a bill read in Excel has to
  // carry the same warning the screen does, or the distinction is lost exactly
  // where it matters most.
  const header = [
    'Code', 'Description', 'Section', 'Unit', 'Qty', 'Rate', 'Amount',
    'Confidence', 'Basis', 'Assumption', 'Sources',
  ];
  const lines = [header.join(',')];
  for (const i of items) {
    lines.push(
      [
        esc(i.code),
        esc(i.description),
        esc(i.section),
        esc(i.unit),
        i.qty,
        i.rate,
        Math.round((i.qty || 0) * (i.rate || 0)),
        i.confidence === null ? '' : Math.round(i.confidence * 100),
        esc(i.basis || ''),
        esc(i.assumption || ''),
        esc((i.sources || []).join('; ')),
      ].join(',')
    );
  }
  const { total } = totals(items);
  lines.push(['', 'TOTAL', '', '', '', '', total, '', '', '', ''].join(','));

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.project.code}-boq.csv"`);
  res.send(lines.join('\n'));
});
