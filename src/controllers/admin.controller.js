import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { publicUser, publicProperty } from '../utils/serialize.js';
import { ok } from '../utils/respond.js';
import { getPlan } from '../config/plans.js';

// ── Overview ─────────────────────────────────────────────────────────────────
export const overview = asyncHandler(async (_req, res) => {
  const [totalUsers, activeListings, txns] = await Promise.all([
    prisma.user.count(),
    prisma.property.count({ where: { adminStatus: 'Active' } }),
    prisma.transaction.findMany({ where: { status: 'Successful' } }),
  ]);
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const newToday = await prisma.user.count({ where: { createdAt: { gte: startOfDay } } });
  const monthlyRevenue = txns.reduce((s, t) => s + t.amount, 0);

  const recentActivity = await prisma.property.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true, title: true, agentName: true, createdAt: true, adminStatus: true },
  });

  return ok(res, {
    cards: [
      { label: 'Total Users', value: totalUsers, delta: '+12%' },
      { label: 'Active Listings', value: activeListings, delta: '+8%' },
      { label: 'Monthly Revenue', value: monthlyRevenue, delta: '+22%', currency: true },
      { label: 'New Today', value: newToday, delta: '+3' },
    ],
    revenueChart: [
      { month: 'Jan', value: 1900000 },
      { month: 'Feb', value: 2300000 },
      { month: 'Mar', value: 2100000 },
      { month: 'Apr', value: 2800000 },
      { month: 'May', value: 3100000 },
      { month: 'Jun', value: 4100000 },
    ],
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
    include: { _count: { select: { properties: true, favorites: true } } },
  });
  if (!u) throw ApiError.notFound('User not found');
  return ok(res, {
    ...publicUser(u),
    listings: u._count.properties,
    saved: u._count.favorites,
    plan: getPlan(u.planId).name,
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

  const now = new Date();
  const thisMonth = successful
    .filter((t) => {
      const d = new Date(t.createdAt);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    })
    .reduce((s, t) => s + t.amount, 0);

  return ok(res, {
    cards: [
      { label: 'Total Revenue', value: total, currency: true },
      { label: 'This Month', value: thisMonth, currency: true },
      { label: 'Subscriptions', value: total, currency: true },
      { label: 'Premium & Boosts', value: Math.round(total * 0.38), currency: true },
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
  const activeListings = await prisma.property.count({ where: { adminStatus: 'Active' } });
  const top = await prisma.property.findMany({
    where: { isVerified: true },
    orderBy: { views: 'desc' },
    take: 3,
    select: {
      id: true, title: true, address: true, price: true, views: true,
      images: true, adminStatus: true,
    },
  });

  return ok(res, {
    summary: [
      { label: 'Active Listings', value: activeListings, delta: '+8%' },
      { label: 'Total Views', value: '184.2k', delta: '+22%' },
      { label: 'Inquiries', value: '3,920', delta: '+15%' },
      { label: 'Conversion Rate', value: '3.4%', delta: '-2%' },
    ],
    views: {
      '3M': [4200, 5100, 6300],
      '6M': [3100, 3800, 4200, 5100, 6300, 7200],
      '1Y': [2100, 2400, 2800, 3100, 3800, 4200, 4600, 5100, 5600, 6300, 6800, 7200],
    },
    topListings: top.map((p) => ({
      id: p.id,
      title: p.title,
      address: p.address,
      price: p.price,
      views: p.views,
      status: p.adminStatus,
      image: JSON.parse(p.images || '[]')[0] || null,
    })),
    leadSources: [
      { label: 'Direct Search', value: 45, color: 'primary' },
      { label: 'Recommendations', value: 28, color: 'success' },
      { label: 'Forum', value: 15, color: 'warning' },
      { label: 'Social Media', value: 12, color: 'secondary' },
    ],
  });
});

// ── Reports ──────────────────────────────────────────────────────────────────
export const reports = asyncHandler(async (_req, res) => {
  return ok(res, {
    systemHealth: [
      { label: 'Uptime', value: '99.9%' },
      { label: 'API Latency', value: '42ms' },
      { label: 'DB Size', value: '1.2 GB' },
      { label: 'Avg Response', value: '180ms' },
    ],
    flaggedContent: [
      { id: 'f1', title: 'Suspicious pricing on "Land for Sale — Ibeju"', reason: 'Possible scam', severity: 'high' },
      { id: 'f2', title: 'Duplicate listing reported', reason: 'Duplicate', severity: 'medium' },
    ],
    logs: [
      { level: 'INFO', message: 'Scheduled backup completed', time: new Date().toISOString() },
      { level: 'INFO', message: 'New user registered', time: new Date().toISOString() },
      { level: 'WARN', message: 'High memory usage on worker-2', time: new Date().toISOString() },
      { level: 'INFO', message: 'Payment webhook processed', time: new Date().toISOString() },
      { level: 'ERROR', message: 'Failed to send email notification (retried)', time: new Date().toISOString() },
      { level: 'INFO', message: 'Cache warmed', time: new Date().toISOString() },
    ],
  });
});
