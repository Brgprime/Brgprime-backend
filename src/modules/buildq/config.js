import crypto from 'node:crypto';
import { env as coreEnv, features as coreFeatures } from '../../config/env.js';

// ─────────────────────────────────────────────────────────────────────────────
// BuildQ AI — module configuration.
//
// BuildQ runs inside the BRG Prime deployment and deliberately reuses its
// vendor accounts rather than adding new ones:
//
//   database  → the same Neon Postgres / Prisma client (buildq_* tables)
//   email     → the same Resend account and EMAIL_FROM sender
//   payments  → the same Paystack keys
//   storage   → the same CLOUDINARY_URL (different folder, raw resource type)
//   hosting   → the same Render web service and process
//
// The only genuinely new credential is ANTHROPIC_API_KEY, because BRG Prime
// has no existing AI provider to reuse.
// ─────────────────────────────────────────────────────────────────────────────

// BuildQ signs its tokens with a key derived from the shared JWT secret. No new
// environment variable, and a token minted for one product is cryptographically
// invalid for the other — a BRG Prime token can never authenticate here.
const buildqJwtSecret = crypto
  .createHmac('sha256', coreEnv.jwtSecret)
  .update('buildq.v1')
  .digest('hex');

export const buildqEnv = {
  mountPath: '/buildq',

  jwtSecret: buildqJwtSecret,
  jwtIssuer: 'brg-prime',
  jwtAudience: 'buildq',
  accessExpiresIn: process.env.BUILDQ_ACCESS_EXPIRES_IN || '30m',
  refreshExpiresIn: process.env.BUILDQ_REFRESH_EXPIRES_IN || '30d',

  // Where the BuildQ frontend lives — used for password-reset and invitation
  // links, and as the Paystack return address.
  webUrl: (process.env.BUILDQ_WEB_URL || 'http://localhost:5173').replace(/\/$/, ''),

  // Claude. Model choice is pinned here so every call site stays consistent.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  model: process.env.BUILDQ_MODEL || 'claude-opus-5',

  trialDays: 14,
  bcryptRounds: 12,
};

export const buildqFeatures = {
  email: coreFeatures.email,
  paystack: coreFeatures.paystack,
  storage: coreFeatures.uploads,
  ai: !!buildqEnv.anthropicApiKey,
};

// ─── Plans (spec §8) ─────────────────────────────────────────────────────────
// Naira per month. Enterprise is quoted, not self-serve.
export const PLANS = {
  starter: {
    id: 'starter',
    name: 'Starter',
    monthlyNaira: 18000,
    annualNaira: 15000 * 12,
    seats: 2,
    aiCredits: 500,
    storageGb: 10,
  },
  professional: {
    id: 'professional',
    name: 'Professional',
    monthlyNaira: 54000,
    annualNaira: 54000 * 12,
    seats: 10,
    aiCredits: 2000,
    storageGb: 100,
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    monthlyNaira: null, // custom / sales-led
    annualNaira: null,
    seats: Infinity,
    aiCredits: Infinity,
    storageGb: 1000,
  },
};

// ─── Roles & permissions (spec §14) ──────────────────────────────────────────
export const ROLES = ['admin', 'qs', 'pm', 'client_viewer'];

export const PERMISSIONS = {
  'projects:read': ['admin', 'qs', 'pm', 'client_viewer'],
  'projects:write': ['admin', 'qs', 'pm'],
  'documents:upload': ['admin', 'qs', 'pm'],
  'boq:write': ['admin', 'qs'],
  'variations:approve': ['admin', 'pm'],
  'rates:write': ['admin', 'qs'],
  'team:manage': ['admin'],
  'billing:manage': ['admin'],
  'vendors:unlock': ['admin', 'qs', 'pm'],
};

export function roleCan(role, permission) {
  return (PERMISSIONS[permission] || []).includes(role);
}

// ─── Payment references (spec §15) ───────────────────────────────────────────
// {PREFIX}-{base36 timestamp}-{6 random chars}
export const PAYMENT_PURPOSES = {
  subscription: 'SUB',
  vendor_unlock: 'UNLOCK',
  vendor_listing: 'LISTING',
};

export const VENDOR_LISTING_FEE_NAIRA = 1000;
export const DEFAULT_VENDOR_UNLOCK_NAIRA = 1000;
