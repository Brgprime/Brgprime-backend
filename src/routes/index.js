import { Router } from 'express';
import authRoutes from './auth.routes.js';
import userRoutes from './user.routes.js';
import propertyRoutes from './property.routes.js';
import favoriteRoutes from './favorite.routes.js';
import subscriptionRoutes from './subscription.routes.js';
import forumRoutes from './forum.routes.js';
import notificationRoutes from './notification.routes.js';
import paymentRoutes from './payment.routes.js';
import viewingRoutes from './viewing.routes.js';
import metaRoutes from './meta.routes.js';
import adminRoutes from './admin.routes.js';
import uploadRoutes from './upload.routes.js';

// BuildQ AI — a separate product that shares this deployment and database.
// It owns everything under /api/buildq and nothing outside src/modules/buildq.
import buildqRoutes from '../modules/buildq/index.js';

const router = Router();

// API index / self-documentation.
router.get('/', (_req, res) => {
  res.json({
    name: 'BRG Prime API',
    version: '1.0.0',
    endpoints: {
      auth: ['POST /api/auth/register', 'POST /api/auth/verify-otp', 'POST /api/auth/resend-otp', 'POST /api/auth/login', 'POST /api/auth/forgot-password', 'POST /api/auth/reset-password', 'GET /api/auth/me'],
      users: ['GET /api/users/me', 'PATCH /api/users/me', 'POST /api/users/me/change-password', 'DELETE /api/users/me'],
      properties: ['GET /api/properties', 'GET /api/properties/featured', 'GET /api/properties/recent', 'GET /api/properties/mine', 'GET /api/properties/:id', 'POST /api/properties', 'PATCH /api/properties/:id', 'DELETE /api/properties/:id'],
      favorites: ['GET /api/favorites', 'GET /api/favorites/ids', 'POST /api/favorites/:propertyId/toggle'],
      subscriptions: ['GET /api/subscriptions/plans', 'GET /api/subscriptions/me', 'POST /api/subscriptions/subscribe', 'POST /api/subscriptions/use-premium', 'POST /api/subscriptions/use-boost'],
      forum: ['GET /api/forum/messages', 'POST /api/forum/messages'],
      notifications: ['GET /api/notifications', 'GET /api/notifications/unread-count', 'PATCH /api/notifications/:id/read', 'POST /api/notifications/read-all'],
      payments: ['GET /api/payments', 'POST /api/payments', 'GET /api/payments/paystack/config', 'POST /api/payments/paystack/initialize', 'GET /api/payments/paystack/verify/:reference', 'POST /api/payments/paystack/webhook'],
      uploads: ['POST /api/uploads/image', 'POST /api/uploads/images'],
      viewings: ['GET /api/viewings', 'POST /api/viewings'],
      meta: ['GET /api/meta/locations', 'GET /api/meta/dashboard-stats'],
      admin: ['GET /api/admin/overview', 'GET /api/admin/users', 'GET /api/admin/users/:id', 'PATCH /api/admin/users/:id/status', 'GET /api/admin/listings', 'PATCH /api/admin/listings/:id', 'DELETE /api/admin/listings/:id', 'GET /api/admin/revenue', 'GET /api/admin/analytics', 'GET /api/admin/reports'],
    },
  });
});

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/properties', propertyRoutes);
router.use('/favorites', favoriteRoutes);
router.use('/subscriptions', subscriptionRoutes);
router.use('/forum', forumRoutes);
router.use('/notifications', notificationRoutes);
router.use('/payments', paymentRoutes);
router.use('/viewings', viewingRoutes);
router.use('/meta', metaRoutes);
router.use('/admin', adminRoutes);
router.use('/uploads', uploadRoutes);
router.use('/buildq', buildqRoutes);

export default router;
