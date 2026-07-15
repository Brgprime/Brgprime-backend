import crypto from 'node:crypto';
import { env, features } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

const BASE = 'https://api.paystack.co';

function authHeaders() {
  if (!features.paystack) {
    throw new ApiError(503, 'Payments are not configured. Set PAYSTACK_SECRET_KEY.');
  }
  return {
    Authorization: `Bearer ${env.paystackSecretKey}`,
    'Content-Type': 'application/json',
  };
}

// Initialize a transaction. amountKobo = NGN * 100.
export async function initializeTransaction({ email, amountKobo, reference, metadata }) {
  const res = await fetch(`${BASE}/transaction/initialize`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      email,
      amount: amountKobo,
      reference,
      currency: 'NGN',
      callback_url: env.paystackCallbackUrl,
      metadata,
    }),
  });
  const json = await res.json();
  if (!res.ok || !json.status) {
    throw ApiError.badRequest(json.message || 'Could not initialize payment.');
  }
  return json.data; // { authorization_url, access_code, reference }
}

// Verify a transaction by reference.
export async function verifyTransaction(reference) {
  const res = await fetch(`${BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: authHeaders(),
  });
  const json = await res.json();
  if (!res.ok || !json.status) {
    throw ApiError.badRequest(json.message || 'Could not verify payment.');
  }
  return json.data; // { status: 'success', amount, metadata, customer, ... }
}

// Validate the x-paystack-signature header against the raw request body.
export function verifyWebhookSignature(rawBody, signature) {
  if (!features.paystack) return false;
  const hash = crypto
    .createHmac('sha512', env.paystackSecretKey)
    .update(rawBody)
    .digest('hex');
  return hash === signature;
}
