import { prisma } from '../../../config/prisma.js';
import { env, features } from '../../../config/env.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { BuildqError } from '../lib/errors.js';
import { settle, verifyWebhookSignature, handleWebhookEvent } from '../services/payment.service.js';

// POST /payments/verify — the authenticated equivalent of the app's existing
// /api/paystack/verify. Requires a session, because a payment has to be
// attributed to an organization.
export const verify = asyncHandler(async (req, res) => {
  const { reference } = req.body;
  if (!reference) {
    throw BuildqError.badRequest('A payment reference is required.', { reference: 'Required.' });
  }

  const result = await settle({
    orgId: req.buildqUser.orgId,
    reference,
    actorId: req.buildqUser.id,
  });

  res.json({
    verified: true,
    alreadyApplied: result.alreadyApplied,
    reference,
    amount: Number(result.payment.amountNaira),
    purpose: result.payment.purpose,
    effect: result.effect ?? null,
  });
});

// POST /payments/webhook — public, called by Paystack.
//
// Authentication is the HMAC-SHA512 signature over the RAW body, which the
// BRG Prime app already captures into req.rawBody. Fails closed: an unsigned
// or wrongly signed request is rejected before anything is read from it.
//
// This Paystack account is shared with BRG Prime, so events for its references
// arrive here too. Anything without a matching BuildQ payment row is
// acknowledged and ignored rather than treated as an error — retrying it would
// achieve nothing.
export const webhook = asyncHandler(async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const raw = req.rawBody;

  if (!signature || !raw) {
    throw BuildqError.unauthorized('Missing webhook signature.', 'bad_signature');
  }
  if (!verifyWebhookSignature(raw, signature)) {
    throw BuildqError.unauthorized('Invalid webhook signature.', 'bad_signature');
  }

  // Respond 200 quickly; Paystack retries on anything else, and the work here
  // is short. Errors are logged rather than returned, so a bug in our handling
  // does not cause an endless retry storm.
  let outcome = { handled: false };
  try {
    outcome = await handleWebhookEvent(req.body);
  } catch (err) {
    console.error('[buildq] webhook handling failed:', err?.message || err);
  }

  res.status(200).json({ received: true, ...outcome });
});

// GET /payments/paystack/config — public key for the browser.
//
// Mirrors BRG Prime's /api/payments/paystack/config: the same key, served the
// same way, so the BuildQ frontend needs no VITE_PAYSTACK_PUBLIC_KEY of its own
// and the two products can never drift onto different keys.
export const config = asyncHandler(async (_req, res) => {
  res.json({ publicKey: env.paystackPublicKey, enabled: features.paystack });
});

// GET /payments — the org's payment history.
export const list = asyncHandler(async (req, res) => {
  const rows = await prisma.buildqPayment.findMany({
    where: { orgId: req.buildqUser.orgId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  res.json({
    payments: rows.map((p) => ({
      id: p.id,
      reference: p.reference,
      purpose: p.purpose,
      amount: Number(p.amountNaira),
      status: p.status,
      channel: p.channel,
      paidAt: p.paidAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
    })),
  });
});
