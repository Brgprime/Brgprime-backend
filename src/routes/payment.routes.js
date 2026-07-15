import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as ctrl from '../controllers/payment.controller.js';
import { recordPaymentSchema } from '../controllers/payment.controller.js';
import * as paystack from '../controllers/paystack.controller.js';
import { initializeSchema } from '../controllers/paystack.controller.js';

const router = Router();

// ── Paystack (subscription checkout) ─────────────────────────────────────────
router.get('/paystack/config', paystack.config); // public
router.post('/paystack/webhook', paystack.webhook); // public (signature-verified)
router.post('/paystack/initialize', requireAuth, validate(initializeSchema), paystack.initialize);
router.get('/paystack/verify/:reference', requireAuth, paystack.verify);

// ── Rent payment ledger (PaymentsView) ───────────────────────────────────────
router.get('/', requireAuth, ctrl.listPayments);
router.post('/', requireAuth, validate(recordPaymentSchema), ctrl.recordPayment);

export default router;
