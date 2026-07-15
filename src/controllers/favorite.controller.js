import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { publicProperty } from '../utils/serialize.js';
import { ok } from '../utils/respond.js';

// GET /api/favorites — the current user's saved properties (full objects).
export const listFavorites = asyncHandler(async (req, res) => {
  const favs = await prisma.favorite.findMany({
    where: { userId: req.user.id },
    include: { property: true },
    orderBy: { createdAt: 'desc' },
  });
  const savedSet = new Set(favs.map((f) => f.propertyId));
  const properties = favs
    .filter((f) => f.property)
    .map((f) => publicProperty(f.property, { savedIds: savedSet }));
  return ok(res, properties, { meta: { count: properties.length } });
});

// GET /api/favorites/ids — just the ids (mirrors the favorites store Set).
export const listFavoriteIds = asyncHandler(async (req, res) => {
  const favs = await prisma.favorite.findMany({
    where: { userId: req.user.id },
    select: { propertyId: true },
  });
  const ids = favs.map((f) => f.propertyId);
  return ok(res, { ids, count: ids.length });
});

// POST /api/favorites/:propertyId/toggle — add/remove; returns new state.
export const toggleFavorite = asyncHandler(async (req, res) => {
  const { propertyId } = req.params;
  const property = await prisma.property.findUnique({ where: { id: propertyId } });
  if (!property) throw ApiError.notFound('Property not found');

  const existing = await prisma.favorite.findUnique({
    where: { userId_propertyId: { userId: req.user.id, propertyId } },
  });

  let saved;
  if (existing) {
    await prisma.$transaction([
      prisma.favorite.delete({ where: { id: existing.id } }),
      prisma.property.update({
        where: { id: propertyId },
        data: { saves: { decrement: 1 } },
      }),
    ]);
    saved = false;
  } else {
    await prisma.$transaction([
      prisma.favorite.create({ data: { userId: req.user.id, propertyId } }),
      prisma.property.update({
        where: { id: propertyId },
        data: { saves: { increment: 1 } },
      }),
    ]);
    saved = true;
  }

  const count = await prisma.favorite.count({ where: { userId: req.user.id } });
  return ok(res, { propertyId, saved, count });
});
