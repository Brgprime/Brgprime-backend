import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as ctrl from '../controllers/subscription.controller.js';
import { subscribeSchema } from '../controllers/subscription.controller.js';

const router = Router();

router.get('/plans', ctrl.getPlans); // public
router.get('/me', requireAuth, ctrl.getMySubscription);
router.post('/subscribe', requireAuth, validate(subscribeSchema), ctrl.subscribe);
router.post('/use-premium', requireAuth, ctrl.usePremium);
router.post('/use-boost', requireAuth, ctrl.useBoost);

export default router;
