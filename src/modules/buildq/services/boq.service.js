import { prisma } from '../../../config/prisma.js';
import { renumber, SECTION_ORDER } from '../lib/codes.js';
import { unitForType } from '../lib/serializers.js';

// ─────────────────────────────────────────────────────────────────────────────
// Bill of quantities.
//
// Items always belong to a revision. Editing the current bill mutates the
// current revision in place; regenerating from drawings creates a new one, so
// a variation can point at "Rev B → Rev C" and mean something.
//
// Amount (qty × rate) is computed, never stored (§6).
// ─────────────────────────────────────────────────────────────────────────────

export async function currentRevision(projectId) {
  return prisma.buildqBoqRevision.findFirst({
    where: { projectId },
    orderBy: { version: 'desc' },
    include: { createdBy: true, _count: { select: { items: true } } },
  });
}

export async function currentItems(projectId) {
  const rev = await currentRevision(projectId);
  if (!rev) return { revision: null, items: [] };
  const items = await prisma.buildqBoqItem.findMany({
    where: { revisionId: rev.id },
    orderBy: { sortOrder: 'asc' },
  });
  return { revision: rev, items };
}

// Creates the next revision and writes `items` into it, in bill order.
export async function createRevision(projectId, items, meta = {}) {
  const last = await prisma.buildqBoqRevision.findFirst({
    where: { projectId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const version = (last?.version ?? 0) + 1;
  const ordered = renumber(items);

  return prisma.$transaction(async (tx) => {
    const revision = await tx.buildqBoqRevision.create({
      data: {
        projectId,
        version,
        source: meta.source || 'manual',
        standard: meta.standard || 'NIQS',
        region: meta.region || 'Lagos',
        generatedFrom: meta.generatedFrom || [],
        notes: meta.notes ?? undefined,
        createdById: meta.createdById || null,
      },
    });

    if (ordered.length) {
      await tx.buildqBoqItem.createMany({
        data: ordered.map((i) => ({
          revisionId: revision.id,
          projectId,
          code: i.code,
          description: i.description,
          section: i.section,
          unit: i.unit,
          qty: i.qty,
          rate: i.rate,
          confidence: i.confidence ?? null,
          sources: i.sources || [],
          sortOrder: i.sortOrder,
        })),
      });
    }

    return revision;
  });
}

// Re-derives codes and sort order for a revision after an add or delete, so
// A1.1/A1.2/A2.1 stay contiguous.
export async function resequence(revisionId) {
  const items = await prisma.buildqBoqItem.findMany({
    where: { revisionId },
    orderBy: { sortOrder: 'asc' },
  });
  const ordered = renumber(items);
  await prisma.$transaction(
    ordered.map((i) =>
      prisma.buildqBoqItem.update({
        where: { id: i.id },
        data: { code: i.code, sortOrder: i.sortOrder },
      })
    )
  );
  return ordered;
}

// Totals, by section and overall. Amount is always qty × rate.
export function totals(items) {
  const bySection = {};
  let grand = 0;
  for (const i of items) {
    const amount = (i.qty || 0) * (i.rate || 0);
    bySection[i.section] = (bySection[i.section] || 0) + amount;
    grand += amount;
  }
  const sections = SECTION_ORDER.filter((s) => bySection[s] !== undefined).map((s) => ({
    section: s,
    total: Math.round(bySection[s]),
  }));
  // Anything filed under a section we do not know about still has to appear.
  for (const s of Object.keys(bySection)) {
    if (!SECTION_ORDER.includes(s)) sections.push({ section: s, total: Math.round(bySection[s]) });
  }
  return { sections, total: Math.round(grand) };
}

// Converts takeoff measurements into priced BOQ items.
//
// A measurement is a raw dimension, not a work item: an area off a plan does
// not say what the area IS. So this maps only what it can defend — the unit and
// the quantity — and prices it from the rate library by name match. It never
// invents the concrete/formwork split from a bare area; that is the analysis
// engine's job (§9), and doing it here from an unlabelled number would be the
// same guessing the spec calls out.
export async function itemsFromMeasurements(measurements, { orgId, region = 'Lagos' }) {
  const rates = await prisma.buildqRate.findMany({
    where: { region, OR: [{ orgId }, { orgId: null }] },
    orderBy: { orgId: 'desc' }, // an org's own rate wins over the global one
  });

  const byName = new Map();
  for (const r of rates) {
    const key = r.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, r);
  }

  const skipped = [];
  const items = [];

  for (const m of measurements) {
    if (!m.value || m.value <= 0) {
      skipped.push({ name: m.name, reason: 'zero quantity' });
      continue;
    }
    const unit = m.unit || unitForType(m.type);
    const match = byName.get(String(m.name).toLowerCase());

    if (match && match.unit !== unit) {
      // Refusing to price a length at an area rate — the dimensional check the
      // frontend already performs, enforced server-side.
      skipped.push({ name: m.name, reason: `rate is per ${match.unit}, measurement is in ${unit}` });
      continue;
    }

    items.push({
      description: m.name,
      section: 'Superstructure',
      unit,
      qty: m.value,
      rate: match ? match.rateNaira : 0,
      // Carried straight through: a measured confidence stays, an entered one
      // has none, and we do not manufacture one for the rate.
      confidence: m.confidence ?? null,
      sources: m.document?.name ? [m.document.name] : [],
    });
  }

  return { items, skipped };
}
