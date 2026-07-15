import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { publicViewing } from '../utils/serialize.js';
import { ok, created } from '../utils/respond.js';

export const bookViewingSchema = z.object({
  propertyId: z.string().min(1, 'Property is required'),
  fullName: z.string().trim().min(1, 'Full name is required'),
  phone: z.string().trim().min(6, 'A valid phone number is required'),
  email: z.string().trim().email().optional().or(z.literal('')).default(''),
  date: z.string().trim().min(1, 'Preferred date is required'),
  time: z.string().trim().min(1, 'Preferred time is required'),
  message: z.string().trim().max(1000).optional().default(''),
});

// GET /api/viewings — the current user's booked viewings.
export const listViewings = asyncHandler(async (req, res) => {
  const rows = await prisma.viewing.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
  });
  return ok(res, rows.map(publicViewing));
});

// POST /api/viewings — book a viewing; also drops a notification.
export const bookViewing = asyncHandler(async (req, res) => {
  const b = req.body;
  const property = await prisma.property.findUnique({ where: { id: b.propertyId } });
  if (!property) throw ApiError.notFound('Property not found');

  const viewing = await prisma.viewing.create({
    data: {
      userId: req.user.id,
      propertyId: b.propertyId,
      fullName: b.fullName,
      phone: b.phone,
      email: b.email || '',
      date: b.date,
      time: b.time,
      message: b.message || '',
      status: 'Confirmed',
    },
  });

  await prisma.notification.create({
    data: {
      userId: req.user.id,
      title: 'Viewing Scheduled',
      message: `A viewing for ${property.title} is scheduled for ${b.date} at ${b.time}.`,
      type: 'viewing',
    },
  });

  return created(res, publicViewing(viewing), {
    message: `Viewing confirmed for ${b.date} at ${b.time}!`,
  });
});
