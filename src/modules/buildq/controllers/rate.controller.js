import { prisma } from '../../../config/prisma.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { BuildqError } from '../lib/errors.js';
import { serializeRate } from '../lib/serializers.js';
import { normalizeUnit } from '../lib/units.js';
import { parseCsv, pick, parseMoney } from '../lib/csv.js';
import { BILL_SKELETON } from '../lib/billing-rules.js';
import { STALE_RATE_DAYS } from '../lib/serializers.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// % movement against the earlier price, from rate_history. Returns 0 with
// hasHistory:false when there is no earlier reading at all — the frontend's
// shape cannot distinguish "flat" from "unknown", so both are reported, and
// `since` says which reading the movement was measured from.
//
// Baseline: the last price recorded on or before the 30-day cutoff. A library
// younger than 30 days has none, so it falls back to the OLDEST reading it
// does have rather than reporting "unknown" forever — which is what a strict
// cutoff did, leaving the Pricing screen's change column permanently blank.
function changeFor(rate, history) {
  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);
  const mine = history
    .filter((h) => h.rateId === rate.id && h.rateNaira)
    .sort((a, b) => a.recordedAt - b.recordedAt);
  if (!mine.length) return { change: 0, hasHistory: false, since: null };

  const atCutoff = [...mine].reverse().find((h) => h.recordedAt <= cutoff);
  const baseline = atCutoff || mine[0];

  const pct = ((rate.rateNaira - baseline.rateNaira) / baseline.rateNaira) * 100;
  return {
    change: Math.round(pct * 10) / 10,
    hasHistory: true,
    since: baseline.recordedAt.toISOString(),
  };
}

// GET /rates
export const list = asyncHandler(async (req, res) => {
  const { region, cat, q, scope, page, limit } = req.validatedQuery;
  const orgId = req.buildqUser.orgId;

  const scopeFilter =
    scope === 'global' ? { orgId: null } : scope === 'organization' ? { orgId } : { OR: [{ orgId }, { orgId: null }] };

  const where = {
    ...scopeFilter,
    ...(region && { region }),
    ...(cat && { category: cat }),
    ...(q && { name: { contains: q, mode: 'insensitive' } }),
  };

  const [rows, total] = await Promise.all([
    prisma.buildqRate.findMany({
      where,
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.buildqRate.count({ where }),
  ]);

  const history = await prisma.buildqRateHistory.findMany({
    where: { rateId: { in: rows.map((r) => r.id) } },
  });

  res.json({
    rates: rows.map((r) => {
      const { change, hasHistory, since } = changeFor(r, history);
      return serializeRate(r, change, hasHistory, since);
    }),
    page,
    limit,
    total,
    pages: Math.ceil(total / limit) || 1,
  });
});

// POST /rates — always scoped to the caller's organization. Only BuildQ staff
// curate global rates, and there is no endpoint here that writes one.
export const create = asyncHandler(async (req, res) => {
  const { name, cat, unit, rate, region, source } = req.body;

  const clash = await prisma.buildqRate.findFirst({
    where: { orgId: req.buildqUser.orgId, name, region },
  });
  if (clash) {
    throw BuildqError.conflict(`Your rate library already has "${name}" for ${region}.`, 'rate_exists');
  }

  const created = await prisma.buildqRate.create({
    data: {
      orgId: req.buildqUser.orgId,
      name,
      category: cat,
      unit: normalizeUnit(unit),
      rateNaira: rate,
      region,
      source,
      isDemo: false,
    },
  });

  res.status(201).json({ rate: serializeRate(created) });
});

// PATCH /rates/:rateId — a price change is recorded in history first.
export const update = asyncHandler(async (req, res) => {
  const existing = await prisma.buildqRate.findFirst({
    where: { id: req.params.rateId, orgId: req.buildqUser.orgId },
  });
  if (!existing) {
    throw BuildqError.notFound(
      'That rate does not exist in your library. Global market rates cannot be edited.',
      'rate_not_found'
    );
  }

  const { name, cat, unit, rate, region } = req.body;

  const updated = await prisma.$transaction(async (tx) => {
    if (rate !== undefined && rate !== existing.rateNaira) {
      await tx.buildqRateHistory.create({
        data: { rateId: existing.id, rateNaira: existing.rateNaira },
      });
    }
    return tx.buildqRate.update({
      where: { id: existing.id },
      data: {
        ...(name !== undefined && { name }),
        ...(cat !== undefined && { category: cat }),
        ...(unit !== undefined && { unit: normalizeUnit(unit) }),
        ...(rate !== undefined && { rateNaira: rate }),
        ...(region !== undefined && { region }),
        isDemo: false,
      },
    });
  });

  res.json({ rate: serializeRate(updated) });
});

// DELETE /rates/:rateId
export const remove = asyncHandler(async (req, res) => {
  const existing = await prisma.buildqRate.findFirst({
    where: { id: req.params.rateId, orgId: req.buildqUser.orgId },
  });
  if (!existing) {
    throw BuildqError.notFound(
      'That rate does not exist in your library. Global market rates cannot be deleted.',
      'rate_not_found'
    );
  }
  await prisma.buildqRate.delete({ where: { id: existing.id } });
  res.json({ ok: true });
});

// GET /rates/:rateId/history
export const history = asyncHandler(async (req, res) => {
  const rate = await prisma.buildqRate.findFirst({
    where: { id: req.params.rateId, OR: [{ orgId: req.buildqUser.orgId }, { orgId: null }] },
  });
  if (!rate) throw BuildqError.notFound('That rate does not exist.', 'rate_not_found');

  const rows = await prisma.buildqRateHistory.findMany({
    where: { rateId: rate.id },
    orderBy: { recordedAt: 'desc' },
  });

  const { change, hasHistory, since } = changeFor(rate, rows);

  res.json({
    rate: serializeRate(rate, change, hasHistory, since),
    history: rows.map((h) => ({ rate: h.rateNaira, recordedAt: h.recordedAt.toISOString() })),
  });
});

// POST /rates/import — CSV upload.
export const importCsv = asyncHandler(async (req, res) => {
  if (!req.file) throw BuildqError.badRequest('Attach a CSV file.', { file: 'Required.' });

  const { rows } = parseCsv(req.file.buffer.toString('utf8'));
  if (!rows.length) throw BuildqError.badRequest('That file has no data rows.', undefined, 'empty_csv');

  const accepted = [];
  const rejected = [];

  for (const [index, row] of rows.entries()) {
    const name = pick(row, ['name', 'item', 'description', 'desc']);
    const unit = pick(row, ['unit', 'uom']);
    const rateRaw = pick(row, ['rate', 'price', 'amount', 'ratenaira']);
    const cat = pick(row, ['cat', 'category', 'type']) || 'Materials';
    const region = pick(row, ['region', 'location']) || 'Lagos';
    const value = parseMoney(rateRaw);

    // A row missing any of these cannot be a rate. It is reported, not guessed.
    if (!name || !unit || value === null || value <= 0) {
      rejected.push({
        row: index + 2, // +1 for the header, +1 for 1-based line numbers
        reason: !name ? 'no name' : !unit ? 'no unit' : 'no usable rate',
      });
      continue;
    }

    accepted.push({
      orgId: req.buildqUser.orgId,
      name,
      category: ['Materials', 'Labour', 'Equipment'].includes(cat) ? cat : 'Materials',
      unit: normalizeUnit(unit),
      rateNaira: Math.round(value),
      region,
      source: req.file.originalname,
      isDemo: false,
    });
  }

  let imported = 0;
  for (const data of accepted) {
    const existing = await prisma.buildqRate.findFirst({
      where: { orgId: data.orgId, name: data.name, region: data.region },
    });
    if (existing) {
      if (existing.rateNaira !== data.rateNaira) {
        await prisma.buildqRateHistory.create({
          data: { rateId: existing.id, rateNaira: existing.rateNaira },
        });
      }
      await prisma.buildqRate.update({ where: { id: existing.id }, data });
    } else {
      await prisma.buildqRate.create({ data });
    }
    imported += 1;
  }

  res.json({ imported, rejected, total: rows.length });
});

// GET /rates/coverage?region=
//
// Which of the items a bill is expected to contain this library can actually
// price. Generation prices every item it bills, so an empty or partial library
// does not fail loudly — it produces a bill full of zeros and a total that
// looks like a discount. This says so in advance, per section, before anyone
// runs a generation and reads the wrong number.
export const coverage = asyncHandler(async (req, res) => {
  const region = String(req.query.region || 'Lagos');
  const orgId = req.buildqUser.orgId;

  const rates = await prisma.buildqRate.findMany({
    where: { region, OR: [{ orgId }, { orgId: null }] },
    orderBy: { orgId: 'desc' },
  });

  const staleBefore = new Date(Date.now() - STALE_RATE_DAYS * 24 * 60 * 60 * 1000);
  const names = rates.map((r) => r.name).join('\n');

  const entries = BILL_SKELETON.map((entry) => {
    const match = rates.find((r) => entry.match.test(r.name));
    return {
      key: entry.key,
      section: entry.section,
      label: entry.label,
      unit: entry.unit,
      priced: Boolean(match),
      // A rate of the wrong dimension cannot price the item even though its
      // name matches — the check that stops a length being priced per m².
      unitMismatch: match ? match.unit !== entry.unit : false,
      rateName: match?.name ?? null,
      rate: match?.rateNaira ?? null,
      effectiveFrom: match?.effectiveFrom ? match.effectiveFrom.toISOString() : null,
      stale: match?.effectiveFrom ? match.effectiveFrom < staleBefore : false,
      isDemo: match?.isDemo ?? false,
      scope: match ? (match.orgId ? 'organization' : 'global') : null,
    };
  });

  const priced = entries.filter((e) => e.priced && !e.unitMismatch);

  res.json({
    region,
    total: entries.length,
    priced: priced.length,
    missing: entries.length - priced.length,
    stale: priced.filter((e) => e.stale).length,
    demo: priced.filter((e) => e.isDemo).length,
    libraryEmpty: rates.length === 0,
    // Ignore `names` beyond the match above; returned so a caller can see what
    // the library actually holds when a lookup surprises them.
    librarySize: rates.length,
    items: entries,
  });
});
