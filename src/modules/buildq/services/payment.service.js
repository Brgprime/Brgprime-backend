import { prisma } from '../../../config/prisma.js';
import {
  verifyTransaction,
  initializeTransaction,
  verifyWebhookSignature,
} from '../../../services/paystack.service.js';
import { BuildqError } from '../lib/errors.js';
import { paymentReference } from '../lib/codes.js';
import { buildqEnv, buildqFeatures, PLANS, VENDOR_LISTING_FEE_NAIRA } from '../config.js';
import { nextPeriodEnd } from './subscription.service.js';

// ─────────────────────────────────────────────────────────────────────────────
// Payments.
//
// The same Paystack account and secret key as BRG Prime — its
// services/paystack.service.js is imported unchanged, not reimplemented.
//
// What this adds over the browser-only flow (§15):
//   • payments are persisted, so clearing site data no longer loses a
//     subscription
//   • verification checks status AND amount server-side, and fails closed
//   • a reference unlocks its product exactly once (idempotency)
//   • the webhook verifies the HMAC-SHA512 signature over the raw body
// ─────────────────────────────────────────────────────────────────────────────

export { verifyWebhookSignature };

const naira = (kobo) => Math.round(kobo / 100);
const kobo = (n) => Math.round(n * 100);

// What a given purpose is supposed to cost, in naira. The server decides this —
// never the browser, which is what stops amount tampering.
export async function expectedAmount(purpose, { plan, vendorId } = {}) {
  if (purpose === 'subscription') {
    const p = PLANS[plan];
    if (!p) throw BuildqError.badRequest(`Unknown plan "${plan}".`, undefined, 'unknown_plan');
    if (p.monthlyNaira === null) {
      throw BuildqError.badRequest(
        'Enterprise is priced by arrangement — contact sales rather than paying online.',
        undefined,
        'plan_not_self_serve'
      );
    }
    return p.monthlyNaira;
  }

  if (purpose === 'vendor_unlock') {
    const vendor = await prisma.buildqVendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw BuildqError.notFound('That vendor does not exist.', 'vendor_not_found');
    return vendor.unlockPrice;
  }

  if (purpose === 'vendor_listing') return VENDOR_LISTING_FEE_NAIRA;

  throw BuildqError.badRequest(`Unknown payment purpose "${purpose}".`, undefined, 'unknown_purpose');
}

// Starts a transaction and records it as pending, so an abandoned payment is
// still traceable.
export async function begin({ orgId, email, purpose, metadata = {} }) {
  // Checked before anything is written: otherwise a missing secret key leaves
  // a pending payment row behind for a transaction that never started.
  if (!buildqFeatures.paystack) {
    throw BuildqError.unavailable(
      'Payments are not configured. Set PAYSTACK_SECRET_KEY.',
      'paystack_unconfigured'
    );
  }

  const amount = await expectedAmount(purpose, metadata);
  const reference = paymentReference(purpose);

  await prisma.buildqPayment.create({
    data: {
      orgId,
      reference,
      purpose,
      amountNaira: BigInt(amount),
      status: 'pending',
      metadata,
    },
  });

  const data = await initializeTransaction({
    email,
    amountKobo: kobo(amount),
    reference,
    metadata: { ...metadata, purpose, orgId, product: 'buildq' },
    callbackUrl: `${buildqEnv.webUrl}/app/billing`,
  });

  return { reference, amount, authorizationUrl: data.authorization_url, accessCode: data.access_code };
}

// Verifies a reference with Paystack and applies its effect exactly once.
// Safe to call repeatedly — the second call reports the same outcome without
// granting anything again.
export async function settle({ orgId, reference, actorId = null }) {
  const record = await prisma.buildqPayment.findUnique({ where: { reference } });

  if (record && record.orgId !== orgId) {
    // Do not confirm that someone else's reference exists.
    throw BuildqError.notFound('That payment reference does not exist.', 'reference_not_found');
  }
  if (record?.status === 'success') {
    return { alreadyApplied: true, payment: record };
  }

  const data = await verifyTransaction(reference);

  if (data.status !== 'success') {
    if (record) {
      await prisma.buildqPayment.update({
        where: { reference },
        data: { status: 'failed', metadata: { ...(record.metadata || {}), paystackStatus: data.status } },
      });
    }
    throw BuildqError.badRequest(
      `That payment did not succeed (Paystack reports "${data.status}").`,
      undefined,
      'payment_not_successful'
    );
  }

  const purpose = record?.purpose || data.metadata?.purpose;
  const metadata = { ...(record?.metadata || {}), ...(data.metadata || {}) };
  if (!purpose) {
    throw BuildqError.badRequest(
      'That payment has no recorded purpose and cannot be applied.',
      undefined,
      'unknown_purpose'
    );
  }

  // Amount tampering check: what was actually paid must cover what the server
  // says the product costs.
  const expected = await expectedAmount(purpose, metadata);
  const paid = naira(data.amount);
  if (paid < expected) {
    await prisma.buildqPayment.updateMany({
      where: { reference },
      data: { status: 'failed' },
    });
    throw BuildqError.badRequest(
      `Paid ₦${paid.toLocaleString()} but ₦${expected.toLocaleString()} was due.`,
      undefined,
      'amount_short'
    );
  }

  const payment = await prisma.buildqPayment.upsert({
    where: { reference },
    create: {
      orgId,
      reference,
      purpose,
      amountNaira: BigInt(paid),
      status: 'success',
      paidAt: new Date(),
      metadata,
    },
    update: {
      status: 'success',
      amountNaira: BigInt(paid),
      paidAt: new Date(),
      metadata,
    },
  });

  const effect = await applyEffect({ orgId, payment, metadata, actorId });
  return { alreadyApplied: false, payment, effect };
}

// Grants whatever the payment bought. Every branch is idempotent.
async function applyEffect({ orgId, payment, metadata, actorId }) {
  if (payment.purpose === 'subscription') {
    const plan = metadata.plan;
    const subscription = await prisma.buildqSubscription.findUnique({ where: { orgId } });
    const periodEnd = nextPeriodEnd(subscription);

    await prisma.buildqSubscription.update({
      where: { orgId },
      data: { status: 'active', plan, currentPeriodEnd: periodEnd, canceledAt: null },
    });

    await prisma.buildqActivityEvent.create({
      data: { orgId, actorId, action: 'subscribed to', target: PLANS[plan]?.name || plan, type: 'success' },
    });

    return { type: 'subscription', plan, currentPeriodEnd: periodEnd };
  }

  if (payment.purpose === 'vendor_unlock') {
    const vendorId = metadata.vendorId;
    // The unique [orgId, vendorId] index makes a repeat unlock a no-op.
    await prisma.buildqVendorUnlock.upsert({
      where: { orgId_vendorId: { orgId, vendorId } },
      create: { orgId, vendorId, paymentId: payment.id },
      update: {},
    });
    return { type: 'vendor_unlock', vendorId };
  }

  if (payment.purpose === 'vendor_listing') {
    const vendorId = metadata.vendorId;
    if (vendorId) {
      await prisma.buildqVendor.updateMany({
        where: { id: vendorId, ownerOrgId: orgId },
        data: { status: 'Pending review', listingFeePaymentId: payment.id },
      });
    }
    return { type: 'vendor_listing', vendorId };
  }

  return { type: 'none' };
}

// ─── Webhook ─────────────────────────────────────────────────────────────────
// charge.success is the one that grants anything; the others adjust state.
export async function handleWebhookEvent(event) {
  const type = event?.event;
  const data = event?.data || {};

  if (type === 'charge.success') {
    const reference = data.reference;
    if (!reference) return { handled: false, reason: 'no reference' };

    const record = await prisma.buildqPayment.findUnique({ where: { reference } });
    // Only BuildQ's own references are ours to act on — this Paystack account
    // is shared with BRG Prime, whose charges must pass straight through.
    if (!record) return { handled: false, reason: 'not a BuildQ reference' };
    if (record.status === 'success') return { handled: true, idempotent: true };

    await settle({ orgId: record.orgId, reference });
    return { handled: true };
  }

  if (type === 'subscription.disable') {
    const orgId = data.metadata?.orgId;
    if (!orgId) return { handled: false, reason: 'no orgId' };
    await prisma.buildqSubscription.updateMany({
      where: { orgId },
      data: { status: 'canceled', canceledAt: new Date() },
    });
    return { handled: true };
  }

  if (type === 'invoice.payment_failed') {
    const orgId = data.metadata?.orgId;
    if (!orgId) return { handled: false, reason: 'no orgId' };
    // past_due rather than expired: access continues to the end of the period
    // already paid for, which is the grace period §15 asks for.
    await prisma.buildqSubscription.updateMany({
      where: { orgId, status: 'active' },
      data: { status: 'past_due' },
    });
    return { handled: true };
  }

  return { handled: false, reason: `unhandled event "${type}"` };
}
