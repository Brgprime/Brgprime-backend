import { prisma } from '../../../config/prisma.js';
import { entitlements } from './subscription.service.js';

// ─────────────────────────────────────────────────────────────────────────────
// Metered usage.
//
// /billing/usage already reported seats, storage and AI credits, but nothing
// read the credit figure back: an organization on Starter (500 credits) could
// run unlimited Claude calls, and every one of them costs real money. Seats are
// enforced at invitation time; this is the same enforcement for credits.
//
// A credit is one model call that we actually paid for — a completed analysis,
// or an assistant reply. Both are counted over the current billing period, or
// over the trial so far.
// ─────────────────────────────────────────────────────────────────────────────

// The start of the period credits are counted against.
export function periodStart(subscription) {
  if (subscription?.status === 'active' && subscription.currentPeriodEnd) {
    const end = new Date(subscription.currentPeriodEnd);
    const start = new Date(end);
    start.setMonth(start.getMonth() - 1);
    return start;
  }
  return subscription?.trialStartedAt ? new Date(subscription.trialStartedAt) : new Date(0);
}

export async function creditsUsed(orgId, subscription) {
  const since = periodStart(subscription);
  const [analyses, assistantMessages] = await Promise.all([
    prisma.buildqAnalysisJob.count({
      where: { document: { orgId }, status: 'succeeded', finishedAt: { gte: since } },
    }),
    prisma.buildqAssistantMessage.count({
      where: { thread: { orgId }, role: 'assistant', createdAt: { gte: since } },
    }),
  ]);
  return { since, analyses, assistantMessages, used: analyses + assistantMessages };
}

export async function storageUsed(orgId) {
  const agg = await prisma.buildqDocument.aggregate({ where: { orgId }, _sum: { sizeBytes: true } });
  return agg._sum.sizeBytes || 0;
}

export async function seatsUsed(orgId) {
  const [members, pending] = await Promise.all([
    prisma.buildqUser.count({ where: { orgId } }),
    prisma.buildqTeamInvitation.count({ where: { orgId, status: 'pending' } }),
  ]);
  return members + pending;
}

// The whole picture, as /billing/usage returns it.
export async function usageSnapshot(orgId, subscription) {
  const ent = entitlements(subscription);
  const [credits, bytes, seats] = await Promise.all([
    creditsUsed(orgId, subscription),
    storageUsed(orgId),
    seatsUsed(orgId),
  ]);

  return {
    periodStart: credits.since.toISOString(),
    seats: { used: seats, limit: ent.seats },
    storage: {
      usedBytes: bytes,
      usedGb: Math.round((bytes / 1024 ** 3) * 100) / 100,
      limitGb: ent.storageGb,
    },
    credits: {
      used: credits.used,
      limit: ent.aiCredits,
      remaining: ent.aiCredits === null ? null : Math.max(0, ent.aiCredits - credits.used),
      analyses: credits.analyses,
      assistantMessages: credits.assistantMessages,
    },
  };
}

// True when the org still has an AI credit to spend. A null limit is unlimited.
export async function hasCredit(orgId, subscription) {
  const ent = entitlements(subscription);
  if (ent.aiCredits === null) return { ok: true, limit: null };
  const { used } = await creditsUsed(orgId, subscription);
  return { ok: used < ent.aiCredits, used, limit: ent.aiCredits };
}
