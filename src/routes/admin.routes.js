import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import * as ctrl from '../controllers/admin.controller.js';

const router = Router();

router.use(requireAuth, requireAdmin);

router.get('/overview', ctrl.overview);

router.get('/users', ctrl.listUsers);
router.get('/users/:id', ctrl.getUser);
router.patch('/users/:id/status', ctrl.setUserStatus);
router.patch('/users/:id/role', ctrl.setUserRole);

router.get('/listings', ctrl.listListings);
router.patch('/listings/:id', ctrl.updateListing);
router.delete('/listings/:id', ctrl.deleteListing);

router.get('/revenue', ctrl.revenue);
router.get('/analytics', ctrl.analytics);
router.get('/reports', ctrl.reports);

export default router;
