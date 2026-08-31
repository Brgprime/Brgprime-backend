import { prisma } from '../../../config/prisma.js';
import { verifyTransaction } from '../../../services/paystack.service.js';
import { buildqFeatures } from '../config.js';
import { settle } from './payment.service.js';

// ─────────────────────────────────────────────────────────────────────────────
// Payment reconciliation.
//
// WHY THIS EXISTS — Paystack delivers webhooks to ONE URL per account, and this
// account is shared with BRG Prime, whose webhook is already registered at
// /api/payments/paystack/webhook. BuildQ's own webhook endpoint is therefore
// never called in practice. Repointing the dashboard at BuildQ would break BRG
// Prime's subscription activation, and BRG Prime must not be modified.
//
// (The two do not interfere: BRG Prime's handler ignores any charge without
// meta.userId AND meta.planId, which BuildQ never sets; BuildQ's handler
// ignores any reference with no matching buildq_payments row.)
//
// So BuildQ cannot rely on being pushed to. It pulls instead: any payment still
// pending after a short grace period is verified directly against Paystack and
// settled. That closes the case the browser cannot cover — the user pays, then
// closes the tab before /payments/verify runs. Without this, money is taken and
// nothing is granted.
//
// settle() is idempotent, so a payment already confirmed by the browser is a
// no-op here.
// ─────────────────────────────────────────────────────────────────────────────

const POLL_MS = Number(process.env.BUILDQ_RECONCILE_POLL_MS || 60_000);
// Long enough that the browser's own verify call normally wins the race.
const GRACE_MS = 3 * 60 * 1000;
// Paystack keeps abandoned transactions around; past this we stop asking.
const ABANDON_MS = 24 * 60 * 60 * 1000;
const BATCH = 10;

let timer = null;
let running = false;

export async function reconcileOnce() {
  const now = Date.now();

  const pending = await prisma.buildqPayment.findMany({
    where: {
      status: 'pending',
      createdAt: { lt: new Date(now - GRACE_MS), gt: new Date(now - 7 * 24 * 60 * 60 * 1000) },
    },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  });

  const outcome = { checked: 0, settled: 0, abandoned: 0, stillPending: 0, errors: 0 };

  for (const payment of pending) {
    outcome.checked += 1;
    try {
      const data = await verifyTransaction(payment.reference);

      if (data.status === 'success') {
        await settle({ orgId: payment.orgId, reference: payment.reference });
        outcome.settled += 1;
        console.log(`[buildq] reconciled ${payment.reference} — ${payment.purpose} settled`);
        continue;
      }

      // Not paid. Give up only once it is clearly stale, so a user who walks
      // away and comes back to finish is not cut off.
      if (now - payment.createdAt.getTime() > ABANDON_MS) {
        await prisma.buildqPayment.update({
          where: { reference: payment.reference },
          data: { status: 'failed', metadata: { ...(payment.metadata || {}), paystackStatus: data.status } },
        });
        outcome.abandoned += 1;
      } else {
        outcome.stillPending += 1;
      }
    } catch (err) {
      // An unknown reference means checkout was never started — Paystack 404s.
      const message = err?.message || String(err);
      if (now - payment.createdAt.getTime() > ABANDON_MS) {
        await prisma.buildqPayment.update({
          where: { reference: payment.reference },
          data: { status: 'failed', metadata: { ...(payment.metadata || {}), lastError: message.slice(0, 200) } },
        });
        outcome.abandoned += 1;
      } else {
        outcome.errors += 1;
      }
    }
  }

  return outcome;
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await reconcileOnce();
  } catch (err) {
    console.error('[buildq] reconciliation failed:', err?.message || err);
  } finally {
    running = false;
  }
}

export function startReconciler() {
  if (timer) return { started: false, reason: 'already running' };
  if (!buildqFeatures.paystack) {
    return { started: false, reason: 'PAYSTACK_SECRET_KEY not set' };
  }
  if (process.env.BUILDQ_RECONCILE_DISABLED === 'true') {
    return { started: false, reason: 'disabled by BUILDQ_RECONCILE_DISABLED' };
  }

  timer = setInterval(tick, POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return { started: true, pollMs: POLL_MS };
}

export function stopReconciler() {
  if (timer) clearInterval(timer);
  timer = null;
}
