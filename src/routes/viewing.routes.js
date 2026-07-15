import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as ctrl from '../controllers/viewing.controller.js';
import { bookViewingSchema } from '../controllers/viewing.controller.js';

const router = Router();

router.use(requireAuth);
router.get('/', ctrl.listViewings);
router.post('/', validate(bookViewingSchema), ctrl.bookViewing);

export default router;
