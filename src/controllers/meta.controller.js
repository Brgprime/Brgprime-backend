import { prisma } from '../config/prisma.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/respond.js';
import { nigerianLocations, majorCities } from '../config/locations.js';

// GET /api/meta/locations — the location list for filters + real popular locations.
export const getLocations = asyncHandler(async (_req, res) => {
  const popularLocations = await computePopularLocations();
  return ok(res, { nigerianLocations, majorCities, popularLocations });
});

// GET /api/meta/dashboard-stats — real platform stats + popular locations.
export const getDashboardStats = asyncHandler(async (_req, res) => {
  const [activeListings, users, owners, popularLocations] = await Promise.all([
    prisma.property.count({ where: { adminStatus: 'Active' } }),
    prisma.user.count(),
    prisma.property.findMany({ where: { ownerId: { not: null } }, distinct: ['ownerId'], select: { ownerId: true } }),
    computePopularLocations(),
  ]);
  const locationsCovered = popularLocations.length;

  return ok(res, {
    stats: [
      { label: 'Active Listings', value: activeListings },
      { label: 'Registered Users', value: users },
      { label: 'Agents & Sellers', value: owners.length },
      { label: 'Locations Covered', value: locationsCovered },
    ],
    popularLocations,
  });
});

// Real popular-location counts: how many active listings mention each major city.
async function computePopularLocations() {
  const props = await prisma.property.findMany({
    where: { adminStatus: 'Active' },
    select: { address: true, images: true },
  });
  const out = [];
  for (const city of majorCities.concat(['Lekki', 'Victoria Island', 'Ikoyi'])) {
    const matches = props.filter((p) => p.address?.includes(city));
    if (!matches.length) continue;
    let image = null;
    for (const m of matches) {
      try {
        const imgs = JSON.parse(m.images || '[]');
        if (imgs.length) { image = imgs[0]; break; }
      } catch { /* ignore */ }
    }
    out.push({ name: city, count: matches.length, image });
  }
  // De-dupe (a city may appear twice) keeping the highest count, then sort.
  const seen = new Map();
  for (const o of out) {
    if (!seen.has(o.name) || seen.get(o.name).count < o.count) seen.set(o.name, o);
  }
  return [...seen.values()].sort((a, b) => b.count - a.count).slice(0, 8);
}
