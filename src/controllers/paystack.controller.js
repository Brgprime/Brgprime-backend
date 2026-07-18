import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { env, features } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/respond.js';
import { getPlan, subscriptionSnapshot } from '../config/plans.js';
import {
  initializeTransaction, verifyTransaction, verifyWebhookSignature,
} from '../services/paystack.service.js';
import { activatePlan } from '../services/subscription.service.js';

export const initializeSchema = z.object({
  planId: z.enum(['silver', 'bronze', 'gold']), // free never needs payment
  billing: z.enum(['monthly', 'annual']).optional().default('monthly'),
  // Where Paystack should send the browser after checkout. Mobile passes its
  // own deep link so the user lands back in the app, not in the web app.
  callbackUrl: z.string().url().optional(),
});

// A client-supplied callback must be on an allowlisted origin — otherwise a
// stolen token could be used to bounce a real payment to an attacker's page.
//
// Compare parsed origins, never string prefixes: "https://brgprime.com" is a
// prefix of "https://brgprime.com.evil.example", so a startsWith() check hands
// an attacker the redirect.
function isAllowedCallback(requested) {
  let url;
  try {
    url = new URL(requested);
  } catch {
    return false;
  }

  return [env.webUrl, env.paystackCallbackUrl, ...env.paystackAllowedCallbacks]
    .some((entry) => {
      // Scheme-only entry (e.g. "brgprime://") — a mobile deep link.
      const schemeOnly = /^[a-z][a-z0-9+.-]*:\/*$/i.exec(entry);
      if (schemeOnly) return url.protocol === `${entry.replace(/\/*$/, '')}`;

      try {
        const allowed = new URL(entry);
        // Custom schemes parse with origin "null", so fall back to protocol
        // plus host, which is what actually identifies the destination.
        return url.protocol === allowed.protocol && url.host === allowed.host;
      } catch {
        return false;
      }
    });
}

function resolveCallbackUrl(requested) {
  if (!requested) return env.paystackCallbackUrl;
  if (!isAllowedCallback(requested)) {
    throw ApiError.badRequest('callbackUrl is not an allowed return address.');
  }
  return requested;
}

// POST /api/payments/paystack/initialize — start a subscription checkout.
export const initialize = asyncHandler(async (req, res) => {
  const { planId, billing, callbackUrl } = req.body;
  const plan = getPlan(planId);
  const amountNaira = plan.price * (billing === 'annual' ? 12 : 1);
  const reference = `BRG-${req.user.id.slice(-6)}-${Date.now()}`;

  const data = await initializeTransaction({
    email: req.user.email,
    amountKobo: amountNaira * 100,
    reference,
    callbackUrl: resolveCallbackUrl(callbackUrl),
    metadata: { userId: req.user.id, planId, billing, custom_fields: [] },
  });

  return ok(res, {
    authorizationUrl: data.authorization_url,
    accessCode: data.access_code,
    reference: data.reference,
    publicKey: env.paystackPublicKey,
    amount: amountNaira,
  });
});

// GET /api/payments/paystack/verify/:reference — verify + activate the plan.
export const verify = asyncHandler(async (req, res) => {
  const { reference } = req.params;
  const data = await verifyTransaction(reference);

  if (data.status !== 'success') {
    throw ApiError.badRequest(`Payment ${data.status}. Not activated.`);
  }

  const meta = data.metadata || {};
  const userId = meta.userId || req.user.id;
  if (userId !== req.user.id && req.user.role !== 'admin') {
    throw ApiError.forbidden('This payment belongs to another account.');
  }

  const user = await activatePlan({
    userId,
    planId: meta.planId,
    billing: meta.billing || 'monthly',
    reference,
    amount: Math.round(data.amount / 100),
  });

  const plan = getPlan(meta.planId);
  return ok(res, subscriptionSnapshot(user), {
    message: `${plan.name} activated — enjoy your new plan!`,
  });
});

// POST /api/payments/paystack/webhook — Paystack server-to-server callback.
// Mounted with a raw body parser so the signature can be verified.
export const webhook = asyncHandler(async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const raw = req.rawBody || JSON.stringify(req.body);

  if (!verifyWebhookSignature(raw, signature)) {
    return res.status(401).json({ success: false, error: { message: 'Invalid signature.' } });
  }

  const event = req.body;
  if (event.event === 'charge.success') {
    const data = event.data;
    const meta = data.metadata || {};
    if (meta.userId && meta.planId) {
      await activatePlan({
        userId: meta.userId,
        planId: meta.planId,
        billing: meta.billing || 'monthly',
        reference: data.reference,
        amount: Math.round(data.amount / 100),
      }).catch((e) => console.error('Webhook activation failed:', e.message));
    }
  }

  // Always 200 quickly so Paystack stops retrying.
  return res.sendStatus(200);
});

// GET /api/payments/paystack/config — public key for client-side Paystack Popup.
export const config = asyncHandler(async (_req, res) => {
  return ok(res, { publicKey: env.paystackPublicKey, enabled: features.paystack });
});
