import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { publicUser, publicProperty } from '../utils/serialize.js';
import { ok } from '../utils/respond.js';
import { getPlan, subscriptionSnapshot } from '../config/plans.js';

// ── Real-computation helpers ─────────────────────────────────────────────────
const startOfMonth = (offset = 0) => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + offset, 1);
};

// Month-over-month growth string; '' when there's no prior baseline.
const growth = (cur, prev) => {
  if (!prev) return cur > 0 ? '+100%' : '';
  const g = Math.round(((cur - prev) / prev) * 100);
  return `${g >= 0 ? '+' : ''}${g}%`;
};

// Sum successful transaction amounts per month, for the last N months.
function monthlyRevenue(txns, months) {
  const now = new Date();
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const value = txns
      .filter((t) => {
        const td = new Date(t.createdAt);
        return td.getFullYear() === d.getFullYear() && td.getMonth() === d.getMonth();
      })
      .reduce((s, t) => s + t.amount, 0);
    out.push({ month: d.toLocaleString('en', { month: 'short' }), value });
  }
  return out;
}

// Count items (with createdAt) per month, for the last N months → number[].
function monthlyCounts(items, months) {
  const now = new Date();
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(
      items.filter((x) => {
        const td = new Date(x.createdAt);
        return td.getFullYear() === d.getFullYear() && td.getMonth() === d.getMonth();
      }).length
    );
  }
  return out;
}

// ── Overview ─────────────────────────────────────────────────────────────────
export const overview = asyncHandler(async (_req, res) => {
  const thisMonth = startOfMonth(0);
  const lastMonth = startOfMonth(-1);
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [totalUsers, activeListings, txns, newToday,
    usersThis, usersLast, listThis, listLast] = await Promise.all([
    prisma.user.count(),
    prisma.property.count({ where: { adminStatus: 'Active' } }),
    prisma.transaction.findMany({ where: { status: 'Successful' } }),
    prisma.user.count({ where: { createdAt: { gte: startOfDay } } }),
    prisma.user.count({ where: { createdAt: { gte: thisMonth } } }),
    prisma.user.count({ where: { createdAt: { gte: lastMonth, lt: thisMonth } } }),
    prisma.property.count({ where: { createdAt: { gte: thisMonth } } }),
    prisma.property.count({ where: { createdAt: { gte: lastMonth, lt: thisMonth } } }),
  ]);

  const sumIn = (from, to) =>
    txns.filter((t) => {
      const td = new Date(t.createdAt);
      return td >= from && (!to || td < to);
    }).reduce((s, t) => s + t.amount, 0);
  const revThis = sumIn(thisMonth);
  const revLast = sumIn(lastMonth, thisMonth);

  const recentActivity = await prisma.property.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true, title: true, agentName: true, createdAt: true, adminStatus: true },
  });

  return ok(res, {
    cards: [
      { label: 'Total Users', value: totalUsers, delta: growth(usersThis, usersLast) },
      { label: 'Active Listings', value: activeListings, delta: growth(listThis, listLast) },
      { label: 'Monthly Revenue', value: revThis, delta: growth(revThis, revLast), currency: true },
      { label: 'New Today', value: newToday, delta: '' },
    ],
    revenueChart: monthlyRevenue(txns, 6),
    recentActivity: recentActivity.map((p) => ({
      id: p.id,
      title: p.title,
      by: p.agentName,
      status: p.adminStatus,
      time: p.createdAt,
    })),
  });
});

// ── Users ────────────────────────────────────────────────────────────────────
const userQuery = z.object({
  search: z.string().trim().optional(),
  status: z.enum(['All', 'Active', 'Disabled']).optional(),
});

export const listUsers = asyncHandler(async (req, res) => {
  const qy = userQuery.parse(req.query);
  const where = { AND: [] };
  if (qy.search) {
    where.AND.push({
      OR: [{ name: { contains: qy.search } }, { email: { contains: qy.search } }],
    });
  }
  if (qy.status && qy.status !== 'All') {
    where.AND.push({ status: qy.status === 'Active' ? 'active' : 'disabled' });
  }

  const users = await prisma.user.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { properties: true } } },
  });

  const rows = users.map((u) => ({
    ...publicUser(u),
    listings: u._count.properties,
    plan: getPlan(u.planId).name,
  }));

  const [total, active] = [users.length, users.filter((u) => u.status === 'active').length];
  return ok(res, rows, {
    meta: { total, active, disabled: total - active },
  });
});

export const getUser = asyncHandler(async (req, res) => {
  const u = await prisma.user.findUnique({
    where: { id: req.params.id },
    include: {
      _count: {
        select: { properties: true, favorites: true, viewings: true, forumMessages: true },
      },
    },
  });
  if (!u) throw ApiError.notFound('User not found');

  // Listing breakdown + financials + recent activity.
  const [statusGroups, txns, history, recentListings] = await Promise.all([
    prisma.property.groupBy({
      by: ['adminStatus'],
      where: { ownerId: u.id },
      _count: true,
    }),
    prisma.transaction.findMany({ where: { userId: u.id, status: 'Successful' } }),
    prisma.subscriptionHistory.findMany({
      where: { userId: u.id },
      orderBy: { date: 'desc' },
      take: 10,
    }),
    prisma.property.findMany({
      where: { ownerId: u.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, title: true, price: true, adminStatus: true, createdAt: true },
    }),
  ]);

  const listingStatus = { Active: 0, Pending: 0, Disabled: 0 };
  statusGroups.forEach((g) => { listingStatus[g.adminStatus] = g._count; });
  const totalSpent = txns.reduce((s, t) => s + t.amount, 0);
  const snap = subscriptionSnapshot(u);

  return ok(res, {
    ...publicUser(u),
    plan: getPlan(u.planId).name,
    listings: u._count.properties,
    listingStatus,
    saved: u._count.favorites,
    viewings: u._count.viewings,
    forumMessages: u._count.forumMessages,
    totalSpent,
    transactionsCount: txns.length,
    premiumUsed: snap.premiumUsed,
    premiumLimit: snap.premiumLimit,
    boostsUsed: snap.boostsUsed,
    boostLimit: snap.boostLimit,
    renewsAt: snap.renewsAt,
    subscriptionHistory: history.map((h) => ({ plan: h.plan, amount: h.amount, date: h.date })),
    recentListings: recentListings.map((p) => ({
      id: p.id, title: p.title, price: p.price, status: p.adminStatus, createdAt: p.createdAt,
    })),
  });
});

export const setUserStatus = asyncHandler(async (req, res) => {
  const status = req.body?.status === 'disabled' ? 'disabled' : 'active';
  const u = await prisma.user.update({ where: { id: req.params.id }, data: { status } });
  return ok(res, publicUser(u), {
    message: status === 'disabled' ? 'User disabled.' : 'User enabled.',
  });
});

// PATCH /api/admin/users/:id/role — grant or revoke admin access.
export const setUserRole = asyncHandler(async (req, res) => {
  const role = req.body?.role === 'admin' ? 'admin' : 'user';
  // Prevent an admin from removing their own admin access (avoid lockout).
  if (req.params.id === req.user.id && role !== 'admin') {
    throw ApiError.badRequest('You cannot remove your own admin access.');
  }
  const u = await prisma.user.update({ where: { id: req.params.id }, data: { role } });
  return ok(res, publicUser(u), {
    message: role === 'admin' ? 'User is now an admin.' : 'Admin access removed.',
  });
});

// ── Listings management ──────────────────────────────────────────────────────
const listingQuery = z.object({
  search: z.string().trim().optional(),
  status: z.enum(['All', 'Active', 'Pending', 'Disabled']).optional(),
});

export const listListings = asyncHandler(async (req, res) => {
  const qy = listingQuery.parse(req.query);
  const where = { AND: [] };
  if (qy.search) {
    where.AND.push({
      OR: [{ title: { contains: qy.search } }, { address: { contains: qy.search } }],
    });
  }
  if (qy.status && qy.status !== 'All') where.AND.push({ adminStatus: qy.status });

  const rows = await prisma.property.findMany({ where, orderBy: { createdAt: 'desc' } });
  const all = await prisma.property.groupBy({ by: ['adminStatus'], _count: true });
  const counts = { Active: 0, Pending: 0, Disabled: 0 };
  all.forEach((g) => { counts[g.adminStatus] = g._count; });

  return ok(res, rows.map((p) => publicProperty(p)), {
    meta: {
      total: rows.length,
      active: counts.Active,
      pending: counts.Pending,
      disabled: counts.Disabled,
    },
  });
});

const updateListingSchema = z.object({
  action: z.enum(['toggleVerified', 'approve', 'enable', 'disable']).optional(),
  isVerified: z.boolean().optional(),
  adminStatus: z.enum(['Active', 'Pending', 'Disabled']).optional(),
});

export const updateListing = asyncHandler(async (req, res) => {
  const body = updateListingSchema.parse(req.body);
  const p = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!p) throw ApiError.notFound('Property not found');

  const data = {};
  let message = 'Listing updated.';
  switch (body.action) {
    case 'toggleVerified':
      data.isVerified = !p.isVerified;
      message = data.isVerified ? 'Listing verified.' : 'Verification removed.';
      break;
    case 'approve':
      data.adminStatus = 'Active';
      message = 'Listing approved.';
      break;
    case 'enable':
      data.adminStatus = 'Active';
      message = 'Listing enabled.';
      break;
    case 'disable':
      data.adminStatus = 'Disabled';
      message = 'Listing disabled.';
      break;
    default:
      if (body.isVerified !== undefined) data.isVerified = body.isVerified;
      if (body.adminStatus !== undefined) data.adminStatus = body.adminStatus;
  }

  const updated = await prisma.property.update({ where: { id: p.id }, data });
  return ok(res, publicProperty(updated), { message });
});

export const deleteListing = asyncHandler(async (req, res) => {
  await prisma.property.delete({ where: { id: req.params.id } });
  return ok(res, { deleted: true }, { message: 'Listing deleted.' });
});

// ── Revenue ──────────────────────────────────────────────────────────────────
export const revenue = asyncHandler(async (_req, res) => {
  const txns = await prisma.transaction.findMany({ orderBy: { createdAt: 'desc' } });
  const successful = txns.filter((t) => t.status === 'Successful');
  const total = successful.reduce((s, t) => s + t.amount, 0);
  const pending = txns.filter((t) => t.status === 'Pending').reduce((s, t) => s + t.amount, 0);

  const now = new Date();
  const thisMonth = successful
    .filter((t) => {
      const d = new Date(t.createdAt);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    })
    .reduce((s, t) => s + t.amount, 0);
  const thisYear = successful
    .filter((t) => new Date(t.createdAt).getFullYear() === now.getFullYear())
    .reduce((s, t) => s + t.amount, 0);

  return ok(res, {
    cards: [
      { label: 'Total Revenue', value: total, currency: true },
      { label: 'This Month', value: thisMonth, currency: true },
      { label: 'This Year', value: thisYear, currency: true },
      { label: 'Pending', value: pending, currency: true },
    ],
    transactions: txns.map((t) => ({
      id: t.id,
      reference: t.reference,
      customer: t.customer,
      plan: t.plan,
      amount: t.amount,
      status: t.status,
      channel: t.channel,
      date: t.createdAt,
    })),
  });
});

// ── Analytics (platform-wide) ────────────────────────────────────────────────
export const analytics = asyncHandler(async (_req, res) => {
  const [activeListings, viewsAgg, savesAgg, inquiries, top, allCreated, byType] =
    await Promise.all([
      prisma.property.count({ where: { adminStatus: 'Active' } }),
      prisma.property.aggregate({ _sum: { views: true } }),
      prisma.property.aggregate({ _sum: { saves: true } }),
      prisma.viewing.count(),
      prisma.property.findMany({
        orderBy: { views: 'desc' },
        take: 3,
        select: { id: true, title: true, address: true, price: true, views: true, images: true, adminStatus: true },
      }),
      prisma.property.findMany({ select: { createdAt: true } }),
      prisma.property.groupBy({ by: ['listingType'], where: { adminStatus: 'Active' }, _count: true }),
    ]);

  const totalViews = viewsAgg._sum.views || 0;
  const totalSaves = savesAgg._sum.saves || 0;
  const conversion = totalViews > 0 ? ((inquiries / totalViews) * 100).toFixed(1) : '0.0';

  // Real "listings by type" distribution (replaces synthetic lead sources).
  const typeTotal = byType.reduce((s, g) => s + g._count, 0) || 1;
  const typeLabels = {
    rent: 'For Rent', sale: 'For Sale', shortlet: 'Shortlet', lease: 'For Lease',
    commercialRent: 'Commercial', commercialSale: 'Commercial', land: 'Land',
    landLease: 'Land', jointVenture: 'Joint Venture',
  };
  const colorCycle = ['primary', 'success', 'warning', 'secondary'];
  const listingsByType = byType
    .map((g) => ({ label: typeLabels[g.listingType] || g.listingType, count: g._count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((g, i) => ({ label: g.label, value: Math.round((g.count / typeTotal) * 100), color: colorCycle[i % colorCycle.length] }));

  return ok(res, {
    summary: [
      { label: 'Active Listings', value: activeListings, delta: '' },
      { label: 'Total Views', value: totalViews, delta: '' },
      { label: 'Inquiries', value: inquiries, delta: '' },
      { label: 'Conversion Rate', value: `${conversion}%`, delta: '' },
    ],
    // Real time-series: new listings posted per month.
    seriesLabel: 'New Listings',
    views: {
      '3M': monthlyCounts(allCreated, 3),
      '6M': monthlyCounts(allCreated, 6),
      '1Y': monthlyCounts(allCreated, 12),
    },
    totalSaves,
    topListings: top.map((p) => ({
      id: p.id,
      title: p.title,
      address: p.address,
      price: p.price,
      views: p.views,
      status: p.adminStatus,
      image: JSON.parse(p.images || '[]')[0] || null,
    })),
    // Kept key name `leadSources` for frontend compatibility; now real data.
    leadSourcesLabel: 'Listings by Type',
    leadSources: listingsByType,
  });
});

// ── Reports ──────────────────────────────────────────────────────────────────
export const reports = asyncHandler(async (_req, res) => {
  // Measure a real DB round-trip for latency.
  const t0 = Date.now();
  const [userCount, propCount, txnCount, viewCount, favCount, forumCount] = await Promise.all([
    prisma.user.count(),
    prisma.property.count(),
    prisma.transaction.count(),
    prisma.viewing.count(),
    prisma.favorite.count(),
    prisma.forumMessage.count(),
  ]);
  const dbLatency = Date.now() - t0;
  const totalRecords = userCount + propCount + txnCount + viewCount + favCount + forumCount;

  // Real uptime + memory of this server process.
  const up = process.uptime();
  const upStr = up > 3600 ? `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m`
    : up > 60 ? `${Math.floor(up / 60)}m` : `${Math.floor(up)}s`;
  const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));

  // Real recent-activity feed built from the latest records across tables.
  const [recentUsers, recentProps, recentTxns] = await Promise.all([
    prisma.user.findMany({ orderBy: { createdAt: 'desc' }, take: 5, select: { name: true, createdAt: true } }),
    prisma.property.findMany({ orderBy: { createdAt: 'desc' }, take: 5, select: { title: true, agentName: true, createdAt: true } }),
    prisma.transaction.findMany({ orderBy: { createdAt: 'desc' }, take: 5, select: { plan: true, amount: true, customer: true, status: true, createdAt: true } }),
  ]);
  const logs = [
    ...recentUsers.map((u) => ({ level: 'INFO', message: `New user registered: ${u.name}`, time: u.createdAt })),
    ...recentProps.map((p) => ({ level: 'INFO', message: `Listing posted: ${p.title} (by ${p.agentName})`, time: p.createdAt })),
    ...recentTxns.map((t) => ({
      level: t.status === 'Successful' ? 'INFO' : 'WARN',
      message: `Payment ${t.status.toLowerCase()}: ${t.plan} ₦${t.amount.toLocaleString()} — ${t.customer}`,
      time: t.createdAt,
    })),
  ].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 12);

  return ok(res, {
    systemHealth: [
      { label: 'Server Uptime', value: upStr },
      { label: 'DB Latency', value: `${dbLatency}ms` },
      { label: 'Total Records', value: totalRecords.toLocaleString() },
      { label: 'Memory (RSS)', value: `${rssMb} MB` },
    ],
    flaggedContent: [], // no content flagged (no reports raised)
    logs,
  });
});
