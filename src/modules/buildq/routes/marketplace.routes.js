import { Router } from 'express';

import { requireAuth, requireAccess, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

import * as vendors from '../controllers/vendor.controller.js';
import * as team from '../controllers/team.controller.js';
import * as billing from '../controllers/billing.controller.js';
import * as payments from '../controllers/payment.controller.js';
import * as reports from '../controllers/report.controller.js';

import {
  createVendorSchema,
  updateVendorSchema,
  unlockVendorSchema,
  savePriceSchema,
  inviteSchema,
  updateMemberSchema,
  subscribeSchema,
  verifyPaymentSchema,
  generateReportSchema,
} from '../validators/marketplace.validators.js';

const router = Router();

router.use(requireAuth);

// ─── Billing ─────────────────────────────────────────────────────────────────
// Billing must stay reachable when the trial has expired — otherwise the only
// way out of the paywall would be blocked by the paywall. So these sit above
// requireAccess deliberately.
router.get('/billing/plans', billing.plans);
router.get('/billing/subscription', billing.subscription);
router.get('/billing/usage', billing.usage);
router.get('/billing/invoices', billing.invoices);
router.get('/billing/invoices/:reference/download', billing.downloadInvoice);
router.post(
  '/billing/subscribe',
  requirePermission('billing:manage'),
  validate(subscribeSchema),
  billing.subscribe
);
router.post('/billing/cancel', requirePermission('billing:manage'), billing.cancel);

// Payment verification is likewise pre-paywall — it is how access is restored.
router.post('/payments/verify', validate(verifyPaymentSchema), payments.verify);
router.get('/payments', requirePermission('billing:manage'), payments.list);

// Notifications stay readable too, so an expired account can still see why.
router.get('/notifications', reports.notifications);
router.post('/notifications/read-all', reports.markAllRead);
router.post('/notifications/:notificationId/read', reports.markRead);

// ─── Everything below needs a live trial or subscription ─────────────────────
router.use(requireAccess);

// Vendors
router.get('/vendor-categories', vendors.categories);
router.get('/vendors', vendors.list);
router.get('/vendors/unlocked', vendors.listUnlocked);
router.get('/vendors/:vendorId', vendors.get);
router.post('/vendors', validate(createVendorSchema), vendors.create);
router.patch('/vendors/:vendorId', validate(updateVendorSchema), vendors.update);
router.delete('/vendors/:vendorId', vendors.remove);
router.post(
  '/vendors/:vendorId/unlock',
  requirePermission('vendors:unlock'),
  validate(unlockVendorSchema),
  vendors.unlock
);

// Saved vendor prices
router.get('/saved-prices', vendors.listSavedPrices);
router.post('/saved-prices', validate(savePriceSchema), vendors.saveePrice);
router.delete('/saved-prices/:savedPriceId', vendors.removeSavedPrice);

// Team
router.get('/team', team.list);
router.post(
  '/team/invitations',
  requirePermission('team:manage'),
  validate(inviteSchema),
  team.invite
);
router.post('/team/invitations/:invitationId/resend', requirePermission('team:manage'), team.resend);
router.delete('/team/invitations/:invitationId', requirePermission('team:manage'), team.revoke);
router.patch(
  '/team/members/:memberId',
  requirePermission('team:manage'),
  validate(updateMemberSchema),
  team.updateMember
);
router.delete('/team/members/:memberId', requirePermission('team:manage'), team.removeMember);

// Reports & analytics
router.get('/reports', reports.list);
router.post('/reports/generate', validate(generateReportSchema), reports.generate);
router.get('/reports/:reportId/download', reports.download);
router.get('/analytics/kpis', reports.kpis);
router.get('/analytics/tenders', reports.tenders);

export default router;
