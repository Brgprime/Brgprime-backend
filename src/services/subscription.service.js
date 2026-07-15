import { prisma } from '../config/prisma.js';
import { getPlan } from '../config/plans.js';

// Activate a plan for a user (used by free-plan switch, Paystack verify, webhook).
// Idempotent per reference: won't double-record the same transaction.
export async function activatePlan({ userId, planId, billing = 'monthly', reference, amount }) {
  const plan = getPlan(planId);
  const renewsAt =
    plan.price > 0 ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : null;

  const finalAmount = amount ?? plan.price * (billing === 'annual' ? 12 : 1);

  // Guard against duplicate webhook/verify processing for paid plans.
  if (plan.price > 0 && reference) {
    const existing = await prisma.transaction.findUnique({ where: { reference } });
    if (existing && existing.status === 'Successful') {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      return user;
    }
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;

  const ops = [
    prisma.user.update({
      where: { id: userId },
      data: { planId: plan.id, premiumUsed: 0, boostsUsed: 0, renewsAt },
    }),
  ];

  if (plan.price > 0) {
    ops.push(
      prisma.subscriptionHistory.create({
        data: { userId, plan: plan.name, amount: finalAmount },
      }),
      prisma.transaction.upsert({
        where: { reference: reference || `BRG-${Date.now()}` },
        update: { status: 'Successful', amount: finalAmount, plan: plan.name },
        create: {
          userId,
          reference: reference || `BRG-${Date.now()}`,
          customer: user.name,
          plan: plan.name,
          amount: finalAmount,
          status: 'Successful',
          channel: 'Paystack',
        },
      })
    );
  }

  const [updated] = await prisma.$transaction(ops);
  return updated;
}
