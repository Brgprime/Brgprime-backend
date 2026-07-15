import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as ctrl from '../controllers/user.controller.js';
import { updateProfileSchema, changePasswordSchema } from '../validators/auth.validators.js';

const router = Router();

router.use(requireAuth);
router.get('/me', ctrl.getProfile);
router.patch('/me', validate(updateProfileSchema), ctrl.updateProfile);
router.post('/me/change-password', validate(changePasswordSchema), ctrl.changePassword);
router.delete('/me', ctrl.deleteAccount);

export default router;
