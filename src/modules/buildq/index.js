import { Router } from 'express';
import cookieParser from 'cookie-parser';

import { buildqFeatures, PLANS } from './config.js';
import { buildqNotFound, buildqErrorHandler } from './lib/errors.js';
import publicRoutes from './routes/public.routes.js';
import authRoutes from './routes/auth.routes.js';
import workspaceRoutes from './routes/workspace.routes.js';
import aiRoutes from './routes/ai.routes.js';
import marketplaceRoutes from './routes/marketplace.routes.js';
import { startQueue } from './services/queue.service.js';
import { startReconciler } from './services/reconcile.service.js';

// ─────────────────────────────────────────────────────────────────────────────
// BuildQ AI — mounted at /api/buildq.
//
// Everything BuildQ needs is scoped to this router: its own cookie parsing, its
// own error envelope, its own auth. Mounting it costs the BRG Prime app exactly
// one line in src/routes/index.js, and removing that line removes BuildQ
// entirely without touching another file.
// ─────────────────────────────────────────────────────────────────────────────

const router = Router();

// Scoped to BuildQ — the BRG Prime app does not parse cookies and does not
// start doing so because of this.
router.use(cookieParser());

// Service index, and an honest report of which integrations are actually live.
router.get('/', (_req, res) => {
  res.json({
    name: 'BuildQ AI API',
    version: '1.0.0',
    product: 'AI quantity surveying — runs inside the BRG Prime deployment',
    features: buildqFeatures,
    plans: Object.values(PLANS).map(({ id, name, monthlyNaira, seats, aiCredits, storageGb }) => ({
      id,
      name,
      monthlyNaira,
      seats: Number.isFinite(seats) ? seats : null,
      aiCredits: Number.isFinite(aiCredits) ? aiCredits : null,
      storageGb,
    })),
    endpoints: {
      auth: [
        'POST /api/buildq/auth/signup',
        'POST /api/buildq/auth/login',
        'POST /api/buildq/auth/refresh',
        'POST /api/buildq/auth/logout',
        'POST /api/buildq/auth/password/reset-request',
        'POST /api/buildq/auth/password/reset',
        'POST /api/buildq/auth/password/change',
        'GET /api/buildq/auth/me',
        'PATCH /api/buildq/auth/me',
        'POST /api/buildq/auth/me/photo',
      ],
      projects: [
        'GET|POST /api/buildq/projects',
        'GET|PATCH|DELETE /api/buildq/projects/:projectId',
        'GET /api/buildq/projects/:projectId/activity',
        'GET /api/buildq/projects/:projectId/spend',
      ],
      documents: [
        'POST|GET /api/buildq/projects/:projectId/documents',
        'GET|PATCH|DELETE /api/buildq/documents/:documentId',
        'GET /api/buildq/documents/:documentId/download',
        'GET /api/buildq/documents/:documentId/preview',
      ],
      takeoff: [
        'GET|POST /api/buildq/documents/:documentId/measurements',
        'GET /api/buildq/projects/:projectId/measurements',
        'PATCH|DELETE /api/buildq/measurements/:measurementId',
      ],
      boq: [
        'GET /api/buildq/projects/:projectId/boq',
        'GET /api/buildq/projects/:projectId/boq/revisions',
        'GET /api/buildq/projects/:projectId/boq/export?format=csv',
        'POST /api/buildq/projects/:projectId/boq/items',
        'POST /api/buildq/projects/:projectId/boq/import',
        'PATCH|DELETE /api/buildq/boq/items/:itemId',
      ],
      variations: [
        'GET|POST /api/buildq/projects/:projectId/variations',
        'PATCH|DELETE /api/buildq/variations/:variationId',
      ],
      rates: [
        'GET|POST /api/buildq/rates',
        'PATCH|DELETE /api/buildq/rates/:rateId',
        'GET /api/buildq/rates/:rateId/history',
        'POST /api/buildq/rates/import',
      ],
      estimation: [
        'GET /api/buildq/regions',
        'GET /api/buildq/projects/:projectId/estimate?region=Lagos',
        'POST /api/buildq/projects/:projectId/estimate/recalculate',
        'GET /api/buildq/projects/:projectId/costs',
        'POST /api/buildq/projects/:projectId/costs/import',
        'DELETE /api/buildq/projects/:projectId/costs?source=',
        'PATCH|DELETE /api/buildq/costs/:costLineId',
      ],
      analysis: [
        'POST /api/buildq/analyze (multipart: file, projectId)',
        'GET /api/buildq/analyze/:jobId',
        'POST /api/buildq/boq',
        'POST /api/buildq/documents/:documentId/detect',
        'POST /api/buildq/projects/:projectId/boq/generate',
      ],
      assistant: [
        'GET /api/buildq/assistant/status',
        'POST /api/buildq/assistant/chat (SSE)',
        'GET /api/buildq/assistant/threads',
        'GET|DELETE /api/buildq/assistant/threads/:threadId',
      ],
      vendors: [
        'GET /api/buildq/vendor-categories',
        'GET /api/buildq/vendors?category=&q=',
        'GET /api/buildq/vendors/unlocked',
        'GET /api/buildq/vendors/:vendorId',
        'POST|PATCH|DELETE /api/buildq/vendors',
        'POST /api/buildq/vendors/:vendorId/unlock',
        'GET|POST /api/buildq/saved-prices',
        'DELETE /api/buildq/saved-prices/:savedPriceId',
      ],
      team: [
        'GET /api/buildq/team',
        'POST /api/buildq/team/invitations',
        'POST /api/buildq/team/invitations/:invitationId/resend',
        'DELETE /api/buildq/team/invitations/:invitationId',
        'POST /api/buildq/team/invitations/lookup (public)',
        'POST /api/buildq/team/invitations/accept (public)',
        'PATCH|DELETE /api/buildq/team/members/:memberId',
      ],
      billing: [
        'GET /api/buildq/billing/plans',
        'GET /api/buildq/billing/subscription',
        'GET /api/buildq/billing/usage',
        'GET /api/buildq/billing/invoices',
        'GET /api/buildq/billing/invoices/:reference/download',
        'POST /api/buildq/billing/subscribe',
        'POST /api/buildq/billing/cancel',
        'POST /api/buildq/payments/verify',
        'POST /api/buildq/payments/webhook (public, HMAC-signed)',
      ],
      reporting: [
        'GET /api/buildq/reports',
        'POST /api/buildq/reports/generate',
        'GET /api/buildq/reports/:reportId/download',
        'GET /api/buildq/analytics/kpis',
        'GET /api/buildq/analytics/tenders',
        'GET /api/buildq/notifications',
        'POST /api/buildq/notifications/:notificationId/read',
        'POST /api/buildq/notifications/read-all',
      ],
    },
    // What the engine can actually read. DWG, RVT and IFC are stored and
    // previewed but never guessed at.
    analysable: ['pdf', 'png', 'jpg', 'jpeg', 'dxf'],
  });
});

// Unauthenticated first — the Paystack webhook and invitation acceptance must
// reach their handlers before any router that calls requireAuth for every
// request that touches it.
router.use('/', publicRoutes);

router.use('/auth', authRoutes);
router.use('/', marketplaceRoutes);
router.use('/', workspaceRoutes);
router.use('/', aiRoutes);

// The analysis worker runs inside this process — the spec asks for Redis, but a
// second service was ruled out, so the queue is a Postgres table drained here.
// Starting it on import means BuildQ owns its own lifecycle: src/server.js is
// not touched, and removing the mount line removes the worker with it.
const queue = startQueue();
console.log(
  queue.started
    ? `[buildq] analysis worker running (poll ${queue.pollMs}ms)`
    : `[buildq] analysis worker not started — ${queue.reason}`
);

// Paystack delivers webhooks to one URL per account, and BRG Prime already
// owns it. BuildQ pulls its own payment outcomes instead of waiting to be
// pushed — see services/reconcile.service.js for why.
const reconciler = startReconciler();
console.log(
  reconciler.started
    ? `[buildq] payment reconciler running (poll ${reconciler.pollMs}ms)`
    : `[buildq] payment reconciler not started — ${reconciler.reason}`
);

// BuildQ terminates its own 404s and errors so it can use its own response
// envelope without changing the BRG Prime handlers.
router.use(buildqNotFound);
router.use(buildqErrorHandler);

export default router;
