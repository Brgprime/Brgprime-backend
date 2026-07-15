import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { publicProperty } from '../utils/serialize.js';
import { ok, created } from '../utils/respond.js';
import { subscriptionSnapshot } from '../config/plans.js';
import { TAB_TO_TYPE } from '../validators/property.validators.js';

async function savedSetFor(userId) {
  if (!userId) return null;
  const favs = await prisma.favorite.findMany({
    where: { userId },
    select: { propertyId: true },
  });
  return new Set(favs.map((f) => f.propertyId));
}

// GET /api/properties — list with search, filters, sorting, pagination.
export const listProperties = asyncHandler(async (req, res) => {
  const qy = req.validatedQuery || {};
  const page = qy.page || 1;
  const limit = qy.limit || 24;
  const skip = (page - 1) * limit;

  const where = { AND: [] };

  // Only surface admin-active listings publicly (Pending/Disabled hidden).
  where.AND.push({ adminStatus: 'Active' });

  const search = qy.search || qy.q;
  if (search) {
    where.AND.push({
      OR: [
        { title: { contains: search } },
        { address: { contains: search } },
      ],
    });
  }

  if (qy.location && qy.location !== 'All Locations') {
    where.AND.push({ address: { contains: qy.location } });
  }

  // Tab takes precedence, then explicit listingType.
  let listingType = qy.listingType;
  if (qy.tab && qy.tab !== 'All') listingType = TAB_TO_TYPE[qy.tab] || listingType;
  if (listingType) where.AND.push({ listingType });

  if (qy.propertyType && qy.propertyType !== 'All') {
    where.AND.push({ propertyType: qy.propertyType.toLowerCase() });
  }

  if (qy.minPrice != null) where.AND.push({ price: { gte: qy.minPrice } });
  if (qy.maxPrice != null) where.AND.push({ price: { lte: qy.maxPrice } });

  if (qy.bedrooms != null && qy.bedrooms !== 'Any') {
    where.AND.push({ bedrooms: { gte: Number(qy.bedrooms) } });
  }
  if (qy.bathrooms != null && qy.bathrooms !== 'Any') {
    where.AND.push({ bathrooms: { gte: Number(qy.bathrooms) } });
  }
  if (qy.verifiedOnly) where.AND.push({ isVerified: true });

  if (qy.featured === 'true') where.AND.push({ isVerified: true });
  if (qy.recent === 'true') where.AND.push({ isRecentlyPosted: true });

  if (qy.mine === 'true') {
    if (!req.user) throw ApiError.unauthorized('Sign in to view your listings.');
    // Remove the public-only adminStatus constraint for the owner's own view.
    where.AND = where.AND.filter((c) => !('adminStatus' in c));
    where.AND.push({ ownerId: req.user.id });
  }

  const savedSet = await savedSetFor(req.user?.id);

  if (qy.saved === 'true') {
    if (!req.user) throw ApiError.unauthorized('Sign in to view saved properties.');
    where.AND.push({ id: { in: [...(savedSet || new Set())] } });
  }

  // Sorting. Default = visibility rank (premium, then boosted), then newest.
  let orderBy;
  switch (qy.sort) {
    case 'newest':
      orderBy = [{ createdAt: 'desc' }];
      break;
    case 'priceAsc':
      orderBy = [{ price: 'asc' }];
      break;
    case 'priceDesc':
      orderBy = [{ price: 'desc' }];
      break;
    default:
      orderBy = [{ isPremium: 'desc' }, { isBoosted: 'desc' }, { createdAt: 'desc' }];
  }

  const [total, rows] = await Promise.all([
    prisma.property.count({ where }),
    prisma.property.findMany({ where, orderBy, skip, take: limit }),
  ]);

  return ok(
    res,
    rows.map((p) => publicProperty(p, { savedIds: savedSet })),
    {
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    }
  );
});

// GET /api/properties/featured
export const featured = asyncHandler(async (req, res) => {
  const savedSet = await savedSetFor(req.user?.id);
  const rows = await prisma.property.findMany({
    where: { isVerified: true, adminStatus: 'Active' },
    orderBy: [{ isPremium: 'desc' }, { isBoosted: 'desc' }, { createdAt: 'desc' }],
    take: 6,
  });
  return ok(res, rows.map((p) => publicProperty(p, { savedIds: savedSet })));
});

// GET /api/properties/recent
export const recent = asyncHandler(async (req, res) => {
  const savedSet = await savedSetFor(req.user?.id);
  const rows = await prisma.property.findMany({
    where: { isRecentlyPosted: true, adminStatus: 'Active' },
    orderBy: [{ createdAt: 'desc' }],
    take: 4,
  });
  return ok(res, rows.map((p) => publicProperty(p, { savedIds: savedSet })));
});

// GET /api/properties/mine
export const myListings = asyncHandler(async (req, res) => {
  const savedSet = await savedSetFor(req.user.id);
  const rows = await prisma.property.findMany({
    where: { ownerId: req.user.id },
    orderBy: [{ createdAt: 'desc' }],
  });
  return ok(res, rows.map((p) => publicProperty(p, { savedIds: savedSet })));
});

// GET /api/properties/:id
export const getProperty = asyncHandler(async (req, res) => {
  const savedSet = await savedSetFor(req.user?.id);
  const p = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!p) throw ApiError.notFound('Property not found');
  // Increment view count (best-effort, non-blocking on failure).
  prisma.property.update({ where: { id: p.id }, data: { views: { increment: 1 } } }).catch(() => {});
  return ok(res, publicProperty(p, { savedIds: savedSet }));
});

// POST /api/properties — create a listing (quota + premium/boost gated).
export const createProperty = asyncHandler(async (req, res) => {
  const b = req.body;
  const snap = subscriptionSnapshot(req.user);

  const currentCount = await prisma.property.count({ where: { ownerId: req.user.id } });
  if (currentCount >= snap.listingLimit) {
    throw new ApiError(403, 'Listing Limit Reached', {
      code: 'LISTING_LIMIT_REACHED',
      plan: snap.plan.name,
      limit: snap.listingLimit,
    });
  }

  // Consume premium/boost allowances if requested (paid plans only).
  let isPremium = false;
  let isBoosted = false;
  let premiumUsed = req.user.premiumUsed;
  let boostsUsed = req.user.boostsUsed;

  if (b.isPremium && snap.isPaid && snap.premiumRemaining > 0) {
    isPremium = true;
    premiumUsed += 1;
  }
  if (b.isBoosted && snap.isPaid && snap.boostsRemaining > 0) {
    isBoosted = true;
    boostsUsed += 1;
  }

  const images = b.images && b.images.length ? b.images : ['/properties/p10.jpeg'];

  const [property] = await prisma.$transaction([
    prisma.property.create({
      data: {
        title: b.title,
        address: b.address,
        description: b.description || '',
        price: b.price,
        listingType: b.listingType,
        propertyType: b.propertyType,
        bedrooms: b.bedrooms,
        bathrooms: b.bathrooms,
        size: b.size,
        yearBuilt: b.yearBuilt ?? null,
        furnishingStatus: b.furnishingStatus,
        propertyCondition: b.propertyCondition,
        amenities: JSON.stringify(b.amenities || []),
        images: JSON.stringify(images),
        isRecentlyPosted: true,
        isVerified: false,
        isPremium,
        isBoosted,
        agentName: 'You',
        agentAvatar: req.user.avatarUrl,
        rating: 0,
        reviewCount: 0,
        status: 'Active',
        adminStatus: 'Active',
        ownerId: req.user.id,
      },
    }),
    prisma.user.update({
      where: { id: req.user.id },
      data: { premiumUsed, boostsUsed },
    }),
  ]);

  return created(res, publicProperty(property), { message: 'Listing published successfully!' });
});

// PATCH /api/properties/:id — owner edits their listing.
export const updateProperty = asyncHandler(async (req, res) => {
  const existing = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Property not found');
  if (existing.ownerId !== req.user.id && req.user.role !== 'admin') {
    throw ApiError.forbidden('You can only edit your own listings.');
  }

  const b = req.body;
  const data = {};
  for (const key of [
    'title', 'address', 'description', 'price', 'listingType', 'propertyType',
    'bedrooms', 'bathrooms', 'size', 'yearBuilt', 'furnishingStatus',
    'propertyCondition', 'status',
  ]) {
    if (b[key] !== undefined) data[key] = b[key];
  }
  if (b.amenities !== undefined) data.amenities = JSON.stringify(b.amenities);
  if (b.images !== undefined) data.images = JSON.stringify(b.images);

  const property = await prisma.property.update({ where: { id: existing.id }, data });
  return ok(res, publicProperty(property), { message: 'Listing updated.' });
});

// DELETE /api/properties/:id — owner removes their listing.
export const deleteProperty = asyncHandler(async (req, res) => {
  const existing = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Property not found');
  if (existing.ownerId !== req.user.id && req.user.role !== 'admin') {
    throw ApiError.forbidden('You can only delete your own listings.');
  }
  await prisma.property.delete({ where: { id: existing.id } });
  return ok(res, { deleted: true }, { message: 'Listing deleted.' });
});
