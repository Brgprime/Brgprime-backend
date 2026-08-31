import { prisma } from '../../../config/prisma.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { BuildqError } from '../lib/errors.js';
import { serializeVendor } from '../lib/serializers.js';
import { normalizeUnit } from '../lib/units.js';
import { begin, settle } from '../services/payment.service.js';
import { VENDOR_LISTING_FEE_NAIRA, buildqFeatures } from '../config.js';

// The ten categories from §6.
export const VENDOR_CATEGORIES = [
  { slug: 'roofing', name: 'Roofing Sheets' },
  { slug: 'cement', name: 'Cement & Binders' },
  { slug: 'blocks', name: 'Blocks & Bricks' },
  { slug: 'carpentry', name: 'Carpentry & Timber' },
  { slug: 'steel', name: 'Steel & Reinforcement' },
  { slug: 'tiles', name: 'Tiles & Flooring' },
  { slug: 'plumbing', name: 'Plumbing & Fittings' },
  { slug: 'electrical', name: 'Electrical & Fittings' },
  { slug: 'paint', name: 'Paints & Finishes' },
  { slug: 'aggregates', name: 'Sand & Aggregates' },
];

const CATEGORY_SLUGS = new Set(VENDOR_CATEGORIES.map((c) => c.slug));

// Which vendors this org has paid to see.
async function unlockedIds(orgId) {
  const rows = await prisma.buildqVendorUnlock.findMany({
    where: { orgId },
    select: { vendorId: true },
  });
  return new Set(rows.map((r) => r.vendorId));
}

// GET /vendor-categories
export const categories = asyncHandler(async (_req, res) => {
  const counts = await prisma.buildqVendor.groupBy({
    by: ['category'],
    where: { status: 'Active' },
    _count: { category: true },
  });
  const byCat = Object.fromEntries(counts.map((c) => [c.category, c._count.category]));
  res.json({
    categories: VENDOR_CATEGORIES.map((c) => ({ ...c, vendors: byCat[c.slug] || 0 })),
  });
});

// GET /vendors?category=&q=
export const list = asyncHandler(async (req, res) => {
  const { category, q } = req.query;
  const orgId = req.buildqUser.orgId;

  const where = {
    // A pending listing is visible to its owner only — nobody browses a
    // listing that has not been reviewed.
    OR: [{ status: 'Active' }, { ownerOrgId: orgId }],
    ...(category && { category }),
    ...(q && {
      AND: [
        {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { location: { contains: q, mode: 'insensitive' } },
            { products: { some: { name: { contains: q, mode: 'insensitive' } } } },
          ],
        },
      ],
    }),
  };

  const [vendors, unlocked] = await Promise.all([
    prisma.buildqVendor.findMany({
      where,
      include: { products: true },
      orderBy: [{ verified: 'desc' }, { rating: 'desc' }, { name: 'asc' }],
    }),
    unlockedIds(orgId),
  ]);

  res.json({
    vendors: vendors.map((v) =>
      serializeVendor(v, { unlocked: unlocked.has(v.id), ownedByOrgId: orgId })
    ),
    unlockedCount: unlocked.size,
  });
});

// GET /vendors/:vendorId
export const get = asyncHandler(async (req, res) => {
  const orgId = req.buildqUser.orgId;
  const vendor = await prisma.buildqVendor.findUnique({
    where: { id: req.params.vendorId },
    include: { products: true },
  });
  if (!vendor || (vendor.status !== 'Active' && vendor.ownerOrgId !== orgId)) {
    throw BuildqError.notFound('That vendor does not exist.', 'vendor_not_found');
  }

  const unlock = await prisma.buildqVendorUnlock.findUnique({
    where: { orgId_vendorId: { orgId, vendorId: vendor.id } },
  });

  res.json({ vendor: serializeVendor(vendor, { unlocked: Boolean(unlock), ownedByOrgId: orgId }) });
});

// GET /vendors/unlocked
export const listUnlocked = asyncHandler(async (req, res) => {
  const orgId = req.buildqUser.orgId;
  const unlocks = await prisma.buildqVendorUnlock.findMany({
    where: { orgId },
    include: { vendor: { include: { products: true } } },
    orderBy: { unlockedAt: 'desc' },
  });
  res.json({
    vendors: unlocks.map((u) =>
      serializeVendor(u.vendor, { unlocked: true, ownedByOrgId: orgId })
    ),
  });
});

// POST /vendors/:vendorId/unlock
// Two shapes: with a Paystack reference it verifies and unlocks; without one it
// starts a transaction and hands back the authorization URL.
export const unlock = asyncHandler(async (req, res) => {
  const orgId = req.buildqUser.orgId;
  const vendorId = req.params.vendorId;

  const vendor = await prisma.buildqVendor.findUnique({ where: { id: vendorId } });
  if (!vendor) throw BuildqError.notFound('That vendor does not exist.', 'vendor_not_found');

  if (vendor.ownerOrgId === orgId) {
    return res.json({ unlocked: true, reason: 'You own this listing.' });
  }

  const existing = await prisma.buildqVendorUnlock.findUnique({
    where: { orgId_vendorId: { orgId, vendorId } },
  });
  if (existing) {
    const full = await prisma.buildqVendor.findUnique({
      where: { id: vendorId },
      include: { products: true },
    });
    return res.json({ unlocked: true, vendor: serializeVendor(full, { unlocked: true }) });
  }

  const { reference } = req.body || {};

  if (!reference) {
    const payment = await begin({
      orgId,
      email: req.buildqUser.email,
      purpose: 'vendor_unlock',
      metadata: { vendorId },
    });
    return res.status(202).json({ unlocked: false, payment });
  }

  await settle({ orgId, reference, actorId: req.buildqUser.id });

  const full = await prisma.buildqVendor.findUnique({
    where: { id: vendorId },
    include: { products: true },
  });
  res.json({ unlocked: true, vendor: serializeVendor(full, { unlocked: true }) });
});

// POST /vendors — register a listing. Published only once the fee is paid.
export const create = asyncHandler(async (req, res) => {
  const orgId = req.buildqUser.orgId;
  const { name, category, location, phone, email, whatsapp, years, description, unlockPrice, products } =
    req.body;

  if (!CATEGORY_SLUGS.has(category)) {
    throw BuildqError.validation('Choose a valid category.', { category: 'Unknown category.' });
  }

  // Checked before anything is written. Without this, a listing is created,
  // the payment fails to start, and the unique name then blocks the owner from
  // ever retrying — the listing exists but can never be paid for or replaced.
  if (!buildqFeatures.paystack) {
    throw BuildqError.unavailable(
      'Payments are not configured, so a listing cannot be published yet.',
      'paystack_unconfigured'
    );
  }

  const clash = await prisma.buildqVendor.findUnique({ where: { name } });
  if (clash) {
    // Their own unpaid listing is resumable rather than a dead end.
    if (clash.ownerOrgId === orgId && clash.status === 'Unpaid') {
      await prisma.buildqVendor.delete({ where: { id: clash.id } });
    } else {
      throw BuildqError.conflict('A business with that name is already listed.', 'vendor_name_taken');
    }
  }

  const vendor = await prisma.buildqVendor.create({
    data: {
      name,
      category,
      location,
      phone,
      email,
      whatsapp: whatsapp || phone,
      description: description || '',
      years: years ?? 0,
      unlockPrice: unlockPrice ?? 1000,
      ownerOrgId: orgId,
      // Nothing is fabricated for a new listing (§8).
      rating: 0,
      reviewsCount: 0,
      verified: false,
      status: 'Unpaid',
      products: {
        create: products.map((p) => ({
          name: p.name,
          unit: normalizeUnit(p.unit),
          priceNaira: p.price,
        })),
      },
    },
    include: { products: true },
  });

  // The listing exists but stays invisible until the ₦1,000 fee clears.
  const payment = await begin({
    orgId,
    email: req.buildqUser.email,
    purpose: 'vendor_listing',
    metadata: { vendorId: vendor.id },
  });

  res.status(201).json({
    vendor: serializeVendor(vendor, { ownedByOrgId: orgId }),
    listingFee: VENDOR_LISTING_FEE_NAIRA,
    payment,
    notice: 'Your listing is saved but not published until the listing fee is paid.',
  });
});

// PATCH /vendors/:vendorId — own listing only, and editing is free (§8).
export const update = asyncHandler(async (req, res) => {
  const orgId = req.buildqUser.orgId;
  const vendor = await prisma.buildqVendor.findUnique({ where: { id: req.params.vendorId } });
  if (!vendor || vendor.ownerOrgId !== orgId) {
    throw BuildqError.notFound('That listing does not exist.', 'vendor_not_found');
  }

  const { products, category, ...rest } = req.body;
  if (category && !CATEGORY_SLUGS.has(category)) {
    throw BuildqError.validation('Choose a valid category.', { category: 'Unknown category.' });
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (products) {
      await tx.buildqVendorProduct.deleteMany({ where: { vendorId: vendor.id } });
      await tx.buildqVendorProduct.createMany({
        data: products.map((p) => ({
          vendorId: vendor.id,
          name: p.name,
          unit: normalizeUnit(p.unit),
          priceNaira: p.price,
        })),
      });
    }
    return tx.buildqVendor.update({
      where: { id: vendor.id },
      data: { ...rest, ...(category && { category }) },
      include: { products: true },
    });
  });

  res.json({ vendor: serializeVendor(updated, { ownedByOrgId: orgId }) });
});

// DELETE /vendors/:vendorId
export const remove = asyncHandler(async (req, res) => {
  const vendor = await prisma.buildqVendor.findUnique({ where: { id: req.params.vendorId } });
  if (!vendor || vendor.ownerOrgId !== req.buildqUser.orgId) {
    throw BuildqError.notFound('That listing does not exist.', 'vendor_not_found');
  }
  await prisma.buildqVendor.delete({ where: { id: vendor.id } });
  res.json({ ok: true });
});

// ─── Saved prices ────────────────────────────────────────────────────────────
// GET /saved-prices
export const listSavedPrices = asyncHandler(async (req, res) => {
  const rows = await prisma.buildqSavedPrice.findMany({
    where: { orgId: req.buildqUser.orgId },
    include: { vendor: true },
    orderBy: { savedAt: 'desc' },
  });
  res.json({
    savedPrices: rows.map((s) => ({
      id: s.id,
      vendor: s.vendor.name,
      vendorId: s.vendorId,
      item: s.productName,
      unit: s.unit,
      rate: s.rate,
      category: s.vendor.category,
      savedAt: s.savedAt.toISOString(),
    })),
  });
});

// POST /saved-prices — only from a vendor the org has unlocked.
export const saveePrice = asyncHandler(async (req, res) => {
  const orgId = req.buildqUser.orgId;
  const { vendorId, productName, unit, rate } = req.body;

  const vendor = await prisma.buildqVendor.findUnique({ where: { id: vendorId } });
  if (!vendor) throw BuildqError.notFound('That vendor does not exist.', 'vendor_not_found');

  if (vendor.ownerOrgId !== orgId) {
    const unlockRow = await prisma.buildqVendorUnlock.findUnique({
      where: { orgId_vendorId: { orgId, vendorId } },
    });
    if (!unlockRow) {
      throw BuildqError.forbidden('Unlock this vendor before saving their prices.', 'vendor_locked');
    }
  }

  const saved = await prisma.buildqSavedPrice.create({
    data: { orgId, vendorId, productName, unit: normalizeUnit(unit), rate },
    include: { vendor: true },
  });

  res.status(201).json({
    savedPrice: {
      id: saved.id,
      vendor: saved.vendor.name,
      item: saved.productName,
      unit: saved.unit,
      rate: saved.rate,
      savedAt: saved.savedAt.toISOString(),
    },
  });
});

// DELETE /saved-prices/:savedPriceId
export const removeSavedPrice = asyncHandler(async (req, res) => {
  const row = await prisma.buildqSavedPrice.findFirst({
    where: { id: req.params.savedPriceId, orgId: req.buildqUser.orgId },
  });
  if (!row) throw BuildqError.notFound('That saved price does not exist.', 'saved_price_not_found');
  await prisma.buildqSavedPrice.delete({ where: { id: row.id } });
  res.json({ ok: true });
});
