import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { publicPayment } from '../utils/serialize.js';
import { ok, created } from '../utils/respond.js';

export const recordPaymentSchema = z.object({
  tenantName: z.string().trim().min(1, 'Tenant name is required'),
  property: z.string().trim().min(1, 'Property is required'),
  amount: z.coerce.number().positive('Amount must be greater than zero'),
  status: z.enum(['Paid', 'Pending', 'Overdue', 'Partial']).default('Paid'),
});

// GET /api/payments — history + summary totals (matches PaymentsView cards).
export const listPayments = asyncHandler(async (req, res) => {
  const rows = await prisma.payment.findMany({
    where: { userId: req.user.id },
    orderBy: { date: 'desc' },
  });

  const now = new Date();
  const summary = { received: 0, pending: 0, overdue: 0, thisMonth: 0 };
  for (const p of rows) {
    if (p.status === 'Paid') summary.received += p.amount;
    else if (p.status === 'Pending' || p.status === 'Partial') summary.pending += p.amount;
    else if (p.status === 'Overdue') summary.overdue += p.amount;
    const d = new Date(p.date);
    if (p.status === 'Paid' && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) {
      summary.thisMonth += p.amount;
    }
  }

  return ok(res, rows.map(publicPayment), { meta: { summary } });
});

// POST /api/payments — record a payment (prepends to list).
export const recordPayment = asyncHandler(async (req, res) => {
  const p = await prisma.payment.create({
    data: { ...req.body, userId: req.user.id },
  });
  return created(res, publicPayment(p), { message: 'Payment recorded.' });
});
