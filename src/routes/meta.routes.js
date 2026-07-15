import { Router } from 'express';
import * as ctrl from '../controllers/meta.controller.js';

const router = Router();

router.get('/locations', ctrl.getLocations);
router.get('/dashboard-stats', ctrl.getDashboardStats);

export default router;
