import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { validate } from '../middleware/validate.js';
import { acceptInviteSchema, lookupInviteSchema } from '../validators/marketplace.validators.js';
import * as payments from '../controllers/payment.controller.js';
import * as team from '../controllers/team.controller.js';

// ─────────────────────────────────────────────────────────────────────────────
// Endpoints that cannot require a session.
//
// This router is mounted BEFORE the authenticated ones. That ordering matters:
// the workspace and AI routers call router.use(requireAuth) with no path, which
// runs for every request reaching them — so a webhook mounted after them would
// be rejected with 401 before it was ever matched.
// ─────────────────────────────────────────────────────────────────────────────

const router = Router();

// Paystack calls this; it authenticates with an HMAC signature, not a token.
// Deliberately not rate-limited — throttling a payment provider's retries would
// lose charges.
router.post('/payments/webhook', payments.webhook);

// The same public key BRG Prime serves, so the two products cannot drift onto
// different Paystack keys.
router.get('/payments/paystack/config', payments.config);

// The invitee has no account yet, so this is how they get one.
const acceptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: { code: 'rate_limited', message: 'Too many attempts. Please try again shortly.' },
  },
});

// Tells the link's holder which form to show — create an account, or sign in
// with the one this address already has.
router.post(
  '/team/invitations/lookup',
  acceptLimiter,
  validate(lookupInviteSchema),
  team.lookupInvitation
);

router.post(
  '/team/invitations/accept',
  acceptLimiter,
  validate(acceptInviteSchema),
  team.accept
);

export default router;
