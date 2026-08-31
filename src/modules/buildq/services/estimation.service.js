import { prisma } from '../../../config/prisma.js';
import { currentItems, totals } from './boq.service.js';

// ─────────────────────────────────────────────────────────────────────────────
// Cost estimation.
//
// Two deliberate departures from the frontend's current behaviour, both because
// the numbers involved are demo figures:
//
//   1. There is NO fallback basis. The frontend falls back to ₦185,200,000 when
//      a project has no BOQ — a fabricated number presented as an estimate.
//      Here, no BOQ means basis 0 and an explicit note.
//   2. Benchmarks are not scaled. The frontend scales by `basis / 185,200,000`,
//      which bakes that same invented figure into every comparison. A benchmark
//      is emitted only when an administrator has set a real one on the region.
// ─────────────────────────────────────────────────────────────────────────────

// DEMO split, from the frontend. Replace with the firm's own overhead structure
// before production — these percentages are not measured from anything.
export const CATEGORY_SPLIT = {
  materials: { share: 0.53, driver: 'materialFactor' },
  labour: { share: 0.28, driver: 'labourFactor' },
  equipment: { share: 0.11, driver: 'equipmentFactor' },
  // Overheads & profit carry no regional driver — a firm's margin does not
  // change because the site moved.
  overheads: { share: 0.08, driver: null },
};

export async function listRegions() {
  return prisma.buildqRegion.findMany({ orderBy: { name: 'asc' } });
}

export async function getRegion(name) {
  if (!name) return null;
  return prisma.buildqRegion.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
}

export async function estimate(projectId, { regionName = 'Lagos', orgId }) {
  const { revision, items } = await currentItems(projectId);
  const { sections, total: basis } = totals(items);

  const region = await getRegion(regionName);
  const notes = [];

  if (!revision || !items.length) {
    notes.push({
      type: 'warning',
      text: 'No bill of quantities exists for this project yet, so there is nothing to estimate from.',
    });
  }
  if (!region) {
    notes.push({ type: 'warning', text: `No pricing factors are configured for "${regionName}".` });
  } else if (region.isDemo) {
    notes.push({
      type: 'info',
      text: `Regional factors for ${region.name} are demo values and have not been calibrated.`,
    });
  }

  const factors = {
    materialFactor: region?.materialFactor ?? 1,
    labourFactor: region?.labourFactor ?? 1,
    equipmentFactor: region?.equipmentFactor ?? 1,
  };

  const categories = {};
  let total = 0;
  for (const [key, { share, driver }] of Object.entries(CATEGORY_SPLIT)) {
    const value = Math.round(basis * share * (driver ? factors[driver] : 1));
    categories[key] = value;
    total += value;
  }

  // Only a real, administrator-set benchmark is reported. Never derived.
  const benchmark = region && region.benchmarkNaira !== null ? Number(region.benchmarkNaira) : null;
  if (region && benchmark === null && basis > 0) {
    notes.push({
      type: 'info',
      text: `No benchmark has been set for ${region.name}, so no comparison is shown.`,
    });
  }

  const costLines = await prisma.buildqCostLine.findMany({
    where: { orgId, projectId },
    orderBy: { uploadedAt: 'desc' },
  });

  return {
    basis,
    region: region?.name ?? regionName,
    factors: {
      material: factors.materialFactor,
      labour: factors.labourFactor,
      equipment: factors.equipmentFactor,
    },
    categories,
    total,
    benchmark,
    variance: benchmark === null ? null : total - benchmark,
    sections,
    revision: revision ? { id: revision.id, version: revision.version, source: revision.source } : null,
    ownCostLines: costLines.length,
    notes,
  };
}

// Rate analysis: every BOQ item priced against the rate library for the region,
// showing where the firm's own cost data disagrees.
export async function rateAnalysis(projectId, { regionName = 'Lagos', orgId }) {
  const { items } = await currentItems(projectId);
  const [rates, costLines] = await Promise.all([
    prisma.buildqRate.findMany({
      where: { region: regionName, OR: [{ orgId }, { orgId: null }] },
      orderBy: { orgId: 'desc' },
    }),
    prisma.buildqCostLine.findMany({ where: { orgId, projectId } }),
  ]);

  const rateByName = new Map();
  for (const r of rates) {
    const k = r.name.toLowerCase();
    if (!rateByName.has(k)) rateByName.set(k, r);
  }
  const ownByItem = new Map(costLines.map((c) => [c.item.toLowerCase(), c]));

  return items.map((i) => {
    const key = i.description.toLowerCase();
    const libraryRate = rateByName.get(key)?.rateNaira ?? null;
    const own = ownByItem.get(key) ?? null;
    return {
      id: i.id,
      desc: i.description,
      section: i.section,
      unit: i.unit,
      qty: i.qty,
      rate: i.rate,
      amount: Math.round((i.qty || 0) * (i.rate || 0)),
      libraryRate,
      ownRate: own ? own.rate : null,
      // Only computed when both sides exist — no variance against a guess.
      variance: own && i.rate ? Math.round(((own.rate - i.rate) / i.rate) * 1000) / 10 : null,
    };
  });
}
