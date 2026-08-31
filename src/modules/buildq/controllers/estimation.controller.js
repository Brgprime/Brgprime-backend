import { prisma } from '../../../config/prisma.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { BuildqError } from '../lib/errors.js';
import { serializeRegion, serializeCostLine } from '../lib/serializers.js';
import { normalizeUnit } from '../lib/units.js';
import { parseCsv, pick, parseMoney } from '../lib/csv.js';
import { estimate as computeEstimate, rateAnalysis, listRegions } from '../services/estimation.service.js';

// GET /regions — factors and benchmarks.
export const regions = asyncHandler(async (_req, res) => {
  const rows = await listRegions();
  res.json({
    regions: rows.map(serializeRegion),
    ...(rows.some((r) => r.isDemo)
      ? {
          notes: [
            {
              type: 'warning',
              text: 'Some regional factors are demo values. Calibrate them before relying on an estimate.',
            },
          ],
        }
      : {}),
  });
});

// GET /projects/:projectId/estimate?region=Lagos
export const estimate = asyncHandler(async (req, res) => {
  const { region } = req.validatedQuery;
  const [result, analysis] = await Promise.all([
    computeEstimate(req.project.id, { regionName: region, orgId: req.buildqUser.orgId }),
    rateAnalysis(req.project.id, { regionName: region, orgId: req.buildqUser.orgId }),
  ]);
  res.json({ estimate: result, rateAnalysis: analysis });
});

// POST /projects/:projectId/estimate/recalculate
// The estimate is derived on read, so this recomputes and returns rather than
// storing a snapshot that could drift from the BOQ behind it.
export const recalculate = asyncHandler(async (req, res) => {
  const region = req.body?.region || 'Lagos';
  const result = await computeEstimate(req.project.id, {
    regionName: region,
    orgId: req.buildqUser.orgId,
  });
  res.json({ estimate: result });
});

// GET /projects/:projectId/costs
export const listCosts = asyncHandler(async (req, res) => {
  const rows = await prisma.buildqCostLine.findMany({
    where: { orgId: req.buildqUser.orgId, projectId: req.project.id },
    orderBy: { uploadedAt: 'desc' },
  });
  res.json({ costs: rows.map(serializeCostLine) });
});

// POST /projects/:projectId/costs/import — the firm's own priced schedule.
export const importCosts = asyncHandler(async (req, res) => {
  if (!req.file) throw BuildqError.badRequest('Attach a CSV file.', { file: 'Required.' });

  const { rows } = parseCsv(req.file.buffer.toString('utf8'));
  if (!rows.length) throw BuildqError.badRequest('That file has no data rows.', undefined, 'empty_csv');

  const data = [];
  const rejected = [];

  for (const [index, row] of rows.entries()) {
    const item = pick(row, ['item', 'description', 'desc', 'name']);
    const unit = pick(row, ['unit', 'uom']);
    const rate = parseMoney(pick(row, ['rate', 'price', 'unitrate', 'amount']));
    const qtyRaw = pick(row, ['qty', 'quantity']);
    const section = pick(row, ['section', 'element', 'group']);

    if (!item || !unit || rate === null) {
      rejected.push({
        row: index + 2,
        reason: !item ? 'no item description' : !unit ? 'no unit' : 'no usable rate',
      });
      continue;
    }

    const qty = parseMoney(qtyRaw);
    data.push({
      orgId: req.buildqUser.orgId,
      projectId: req.project.id,
      item,
      unit: normalizeUnit(unit),
      rate: Math.round(rate),
      // 0 when the file had no quantity column — not an invented figure.
      qty: qty === null ? 0 : qty,
      section: section || '',
      sourceFile: req.file.originalname,
    });
  }

  if (!data.length) {
    throw BuildqError.badRequest(
      'No usable rows were found in that file.',
      { file: 'Expected columns: item, unit, rate (qty and section optional).' },
      'no_usable_rows'
    );
  }

  await prisma.buildqCostLine.createMany({ data });

  res.status(201).json({ imported: data.length, rejected, total: rows.length });
});

// DELETE /projects/:projectId/costs[?source=quote.csv]
// Clears the uploaded schedule, or just the lines that came from one file.
export const clearCosts = asyncHandler(async (req, res) => {
  const source = req.query?.source ? String(req.query.source) : null;
  const { count } = await prisma.buildqCostLine.deleteMany({
    where: {
      orgId: req.buildqUser.orgId,
      projectId: req.project.id,
      ...(source ? { sourceFile: source } : {}),
    },
  });
  res.json({ ok: true, removed: count, ...(source ? { source } : {}) });
});

// Loads one cost line and proves it belongs to the caller's organization.
async function loadCostLine(orgId, id) {
  const line = await prisma.buildqCostLine.findFirst({ where: { id, orgId } });
  if (!line) throw BuildqError.notFound('That cost line does not exist.', 'cost_line_not_found');
  return line;
}

// PATCH /costs/:costLineId
// An imported schedule is the firm's own data, so it has to be correctable in
// place — a quantity keyed wrong in a supplier's CSV should not mean re-importing
// the file.
export const updateCostLine = asyncHandler(async (req, res) => {
  const existing = await loadCostLine(req.buildqUser.orgId, req.params.costLineId);
  const { item, unit, rate, qty, section } = req.body;

  const line = await prisma.buildqCostLine.update({
    where: { id: existing.id },
    data: {
      ...(item !== undefined && { item }),
      ...(unit !== undefined && { unit: normalizeUnit(unit) }),
      ...(rate !== undefined && { rate: Math.round(rate) }),
      ...(qty !== undefined && { qty }),
      ...(section !== undefined && { section }),
    },
  });

  res.json({ cost: serializeCostLine(line) });
});

// DELETE /costs/:costLineId
export const removeCostLine = asyncHandler(async (req, res) => {
  const existing = await loadCostLine(req.buildqUser.orgId, req.params.costLineId);
  await prisma.buildqCostLine.delete({ where: { id: existing.id } });
  res.json({ ok: true });
});
