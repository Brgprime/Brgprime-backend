import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { publicNotification } from '../utils/serialize.js';
import { ok } from '../utils/respond.js';

// GET /api/notifications — list + unread count.
export const listNotifications = asyncHandler(async (req, res) => {
  const rows = await prisma.notification.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
  });
  const unread = rows.filter((n) => !n.read).length;
  return ok(res, rows.map(publicNotification), { meta: { unread, count: rows.length } });
});

// GET /api/notifications/unread-count
export const unreadCount = asyncHandler(async (req, res) => {
  const unread = await prisma.notification.count({
    where: { userId: req.user.id, read: false },
  });
  return ok(res, { unread });
});

// PATCH /api/notifications/:id/read — mark one as read.
export const markRead = asyncHandler(async (req, res) => {
  const existing = await prisma.notification.findFirst({
    where: { id: req.params.id, userId: req.user.id },
  });
  if (!existing) throw ApiError.notFound('Notification not found');
  const n = await prisma.notification.update({
    where: { id: existing.id },
    data: { read: true },
  });
  return ok(res, publicNotification(n));
});

// POST /api/notifications/read-all — mark all as read.
export const markAllRead = asyncHandler(async (req, res) => {
  await prisma.notification.updateMany({
    where: { userId: req.user.id, read: false },
    data: { read: true },
  });
  return ok(res, { updated: true }, { message: 'All notifications marked as read.' });
});
