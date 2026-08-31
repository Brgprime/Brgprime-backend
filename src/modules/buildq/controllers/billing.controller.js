import { prisma } from '../../../config/prisma.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { BuildqError } from '../lib/errors.js';
import { PLANS, buildqFeatures } from '../config.js';
import { serializeSubscription, entitlements } from '../services/subscription.service.js';
import { begin, settle } from '../services/payment.service.js';
import { usageSnapshot } from '../services/usage.service.js';

const cap = (n) => (Number.isFinite(n) ? n : null);

// GET /billing/plans
export const plans = asyncHandler(async (_req, res) => {
  res.json({
    plans: Object.values(PLANS).map((p) => ({
      id: p.id,
      name: p.name,
      price: p.monthlyNaira,
      annual: p.annualNaira,
      seats: cap(p.seats),
      credits: cap(p.aiCredits),
      storage: p.storageGb,
      selfServe: p.monthlyNaira !== null,
    })),
    // These are the frontend's demo figures. Confirm them before charging real
    // customers — nothing here has been priced against a cost model.
    notes: [{ type: 'warning', text: 'Plan prices are placeholder figures carried over from the pricing page.' }],
    paystackConfigured: buildqFeatures.paystack,
  });
});

// GET /billing/subscription
export const subscription = asyncHandler(async (req, res) => {
  res.json({
    subscription: serializeSubscription(req.buildqSubscription),
    entitlements: entitlements(req.buildqSubscription),
  });
});

// POST /billing/subscribe
// Without a reference this starts a Paystack transaction; with one it verifies
// and activates. The browser never decides that a payment succeeded.
export const subscribe = asyncHandler(async (req, res) => {
  const { plan, reference } = req.body;

  if (!PLANS[plan]) {
    throw BuildqError.validation('Choose a valid plan.', { plan: 'Unknown plan.' });
  }
  if (PLANS[plan].monthlyNaira === null) {
    throw BuildqError.badRequest(
      'Enterprise is priced by arrangement. Contact sales rather than paying online.',
      undefined,
      'plan_not_self_serve'
    );
  }

  if (!reference) {
    const payment = await begin({
      orgId: req.buildqUser.orgId,
      email: req.buildqUser.email,
      purpose: 'subscription',
      metadata: { plan },
    });
    return res.status(202).json({ activated: false, payment });
  }

  const result = await settle({
    orgId: req.buildqUser.orgId,
    reference,
    actorId: req.buildqUser.id,
  });

  const fresh = await prisma.buildqSubscription.findUnique({
    where: { orgId: req.buildqUser.orgId },
  });

  res.json({
    activated: true,
    alreadyApplied: result.alreadyApplied,
    subscription: serializeSubscription(fresh),
    entitlements: entitlements(fresh),
  });
});

// POST /billing/cancel
// Access continues to the end of the period already paid for — cancelling is
// not a refund, and cutting access immediately would be taking the money twice.
export const cancel = asyncHandler(async (req, res) => {
  const current = req.buildqSubscription;
  if (!current || current.status !== 'active') {
    throw BuildqError.badRequest('There is no active subscription to cancel.', undefined, 'not_active');
  }

  const updated = await prisma.buildqSubscription.update({
    where: { orgId: req.buildqUser.orgId },
    data: { status: 'canceled', canceledAt: new Date() },
  });

  await prisma.buildqActivityEvent.create({
    data: {
      orgId: req.buildqUser.orgId,
      actorId: req.buildqUser.id,
      action: 'cancelled the subscription',
      target: current.plan || '',
      type: 'warning',
    },
  });

  res.json({
    subscription: serializeSubscription(updated),
    accessUntil: updated.currentPeriodEnd?.toISOString() ?? null,
  });
});

// GET /billing/invoices — real verified payments only.
export const invoices = asyncHandler(async (req, res) => {
  const rows = await prisma.buildqPayment.findMany({
    where: { orgId: req.buildqUser.orgId, status: 'success' },
    orderBy: { paidAt: 'desc' },
  });

  res.json({
    invoices: rows.map((p) => ({
      id: p.reference,
      purpose: p.purpose,
      plan: p.metadata?.plan ?? null,
      amount: Number(p.amountNaira),
      paidAt: p.paidAt?.toISOString() ?? null,
      channel: p.channel,
    })),
  });
});

// GET /billing/invoices/:reference/download
// A real receipt built from the stored payment, not a placeholder text file.
export const downloadInvoice = asyncHandler(async (req, res) => {
  const payment = await prisma.buildqPayment.findFirst({
    where: { reference: req.params.reference, orgId: req.buildqUser.orgId, status: 'success' },
  });
  if (!payment) throw BuildqError.notFound('That invoice does not exist.', 'invoice_not_found');

  const org = req.buildqOrg;
  const amount = Number(payment.amountNaira);
  const lines = [
    'BuildQ AI — Receipt',
    '===================',
    '',
    `Reference:  ${payment.reference}`,
    `Date:       ${payment.paidAt?.toISOString().slice(0, 10) ?? '—'}`,
    `Billed to:  ${org.name}`,
    `Purpose:    ${payment.purpose.replace(/_/g, ' ')}`,
    ...(payment.metadata?.plan ? [`Plan:       ${PLANS[payment.metadata.plan]?.name ?? payment.metadata.plan}`] : []),
    `Channel:    ${payment.channel}`,
    '',
    `Amount:     NGN ${amount.toLocaleString()}`,
    '',
    'Paid in full. Thank you.',
  ];

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${payment.reference}.txt"`);
  res.send(lines.join('\n'));
});

// GET /billing/usage — seats, storage and AI credits actually consumed.
// The same figures requireCredits enforces against, so the number the screen
// shows and the number the server acts on can never disagree.
export const usage = asyncHandler(async (req, res) => {
  res.json(await usageSnapshot(req.buildqUser.orgId, req.buildqSubscription));
});
