import { buildqEnv, PLANS } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Trial and paywall (spec §8).
//
// The frontend already implements this countdown, but client-side only — which
// means it is bypassable by editing browser storage. This module is the server
// side of the same rules, and `requireAccess` is what actually gates the API.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

export function trialEndFrom(startedAt = new Date()) {
  return new Date(startedAt.getTime() + buildqEnv.trialDays * DAY_MS);
}

export function trialDaysLeft(subscription, now = new Date()) {
  if (!subscription?.trialEndsAt) return 0;
  return Math.max(0, Math.ceil((new Date(subscription.trialEndsAt).getTime() - now.getTime()) / DAY_MS));
}

// calm > 7 days, warning 4–7, critical 1–3, over at 0.
export function trialUrgency(daysLeft) {
  if (daysLeft <= 0) return 'over';
  if (daysLeft <= 3) return 'critical';
  if (daysLeft <= 7) return 'warning';
  return 'calm';
}

export function hasAccess(subscription, now = new Date()) {
  if (!subscription) return false;
  if (subscription.status === 'active') {
    return !!subscription.currentPeriodEnd && new Date(subscription.currentPeriodEnd) > now;
  }
  if (subscription.status === 'trialing') {
    return trialDaysLeft(subscription, now) > 0;
  }
  return false;
}

// The exact shape /auth/me must return so the paywall is server-driven.
export function serializeSubscription(subscription, now = new Date()) {
  if (!subscription) {
    return { status: 'expired', plan: null, trialStartedAt: null, trialEndsAt: null, currentPeriodEnd: null, hasAccess: false, trialDaysLeft: 0, urgency: 'over' };
  }
  const daysLeft = trialDaysLeft(subscription, now);
  return {
    status: subscription.status,
    plan: subscription.plan,
    trialStartedAt: subscription.trialStartedAt?.toISOString?.() ?? subscription.trialStartedAt,
    trialEndsAt: subscription.trialEndsAt?.toISOString?.() ?? subscription.trialEndsAt,
    currentPeriodEnd: subscription.currentPeriodEnd?.toISOString?.() ?? subscription.currentPeriodEnd ?? null,
    hasAccess: hasAccess(subscription, now),
    trialDaysLeft: daysLeft,
    urgency: trialUrgency(daysLeft),
  };
}

// What the plan entitles the org to. Unlimited tiers report null, not Infinity,
// because Infinity does not survive JSON.
export function entitlements(subscription) {
  const plan = PLANS[subscription?.plan];
  if (!plan) {
    return { plan: null, seats: 2, aiCredits: 100, storageGb: 5, trial: true };
  }
  const cap = (n) => (Number.isFinite(n) ? n : null);
  return {
    plan: plan.id,
    seats: cap(plan.seats),
    aiCredits: cap(plan.aiCredits),
    storageGb: cap(plan.storageGb),
    trial: false,
  };
}

// Paying extends the period by one month from the later of now or the existing
// period end, so a renewal never silently discards unused time.
export function nextPeriodEnd(subscription, now = new Date()) {
  const from =
    subscription?.currentPeriodEnd && new Date(subscription.currentPeriodEnd) > now
      ? new Date(subscription.currentPeriodEnd)
      : now;
  const end = new Date(from);
  end.setMonth(end.getMonth() + 1);
  return end;
}
