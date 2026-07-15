import { Router } from 'express';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as ctrl from '../controllers/forum.controller.js';
import { postMessageSchema } from '../controllers/forum.controller.js';

const router = Router();

router.get('/messages', optionalAuth, ctrl.listMessages);
router.post('/messages', requireAuth, validate(postMessageSchema), ctrl.postMessage);

export default router;
