import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/respond.js';
import { features } from '../config/env.js';
import { PLANS, getPlan, subscriptionSnapshot } from '../config/plans.js';
import { activatePlan } from '../services/subscription.service.js';

export const subscribeSchema = z.object({
  planId: z.enum(['free', 'silver', 'bronze', 'gold']),
  billing: z.enum(['monthly', 'annual']).optional().default('monthly'),
  // Simulated Paystack payment reference (optional).
  reference: z.string().optional(),
});

// GET /api/subscriptions/plans — the plan catalogue.
export const getPlans = asyncHandler(async (_req, res) => {
  return ok(res, PLANS);
});

// GET /api/subscriptions/me — current usage snapshot + history + live listing count.
export const getMySubscription = asyncHandler(async (req, res) => {
  const [listingCount, history] = await Promise.all([
    prisma.property.count({ where: { ownerId: req.user.id } }),
    prisma.subscriptionHistory.findMany({
      where: { userId: req.user.id },
      orderBy: { date: 'desc' },
      take: 50,
    }),
  ]);
  const snap = subscriptionSnapshot(req.user);
  return ok(res, {
    ...snap,
    listingsUsed: listingCount,
    history: history.map((h) => ({ plan: h.plan, amount: h.amount, date: h.date })),
  });
});

// POST /api/subscriptions/subscribe
// Free plan applies immediately. For paid plans, real payment goes through
// /api/payments/paystack/*; this endpoint activates directly only in dev/no-Paystack
// mode (or when called by an admin) so local testing still works.
export const subscribe = asyncHandler(async (req, res) => {
  const { planId, billing, reference } = req.body;
  const plan = getPlan(planId);

  if (plan.price > 0 && features.paystack && req.user.role !== 'admin') {
    throw ApiError.badRequest(
      'Use /api/payments/paystack/initialize to pay for a paid plan.'
    );
  }

  const user = await activatePlan({
    userId: req.user.id,
    planId: plan.id,
    billing,
    reference,
  });

  const message =
    plan.price > 0
      ? `${plan.name} activated — enjoy your new plan!`
      : 'You are now on the Free Plan.';
  return ok(res, subscriptionSnapshot(user), { message });
});

// POST /api/subscriptions/use-premium — consume one premium allowance.
export const usePremium = asyncHandler(async (req, res) => {
  const snap = subscriptionSnapshot(req.user);
  if (!snap.unlimited && snap.premiumRemaining <= 0) throw ApiError.badRequest('No premium listings remaining.');
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { premiumUsed: { increment: 1 } },
  });
  return ok(res, subscriptionSnapshot(user));
});

// POST /api/subscriptions/use-boost — consume one boost allowance.
export const useBoost = asyncHandler(async (req, res) => {
  const snap = subscriptionSnapshot(req.user);
  if (!snap.unlimited && snap.boostsRemaining <= 0) throw ApiError.badRequest('No boosts remaining.');
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { boostsUsed: { increment: 1 } },
  });
  return ok(res, subscriptionSnapshot(user));
});
