import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';

import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import {
  signupSchema,
  loginSchema,
  exchangeSchema,
  resetRequestSchema,
  resetSchema,
  changePasswordSchema,
  updateMeSchema,
} from '../validators/auth.validators.js';
import * as ctrl from '../controllers/auth.controller.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Credential endpoints get their own limiter on top of the global /api one
// (spec §14: rate-limit login, signup and password reset).
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: { code: 'rate_limited', message: 'Too many attempts. Please try again in a few minutes.' },
  },
});

router.post('/signup', credentialLimiter, validate(signupSchema), ctrl.signup);
router.post('/login', credentialLimiter, validate(loginSchema), ctrl.login);

// Arriving from BRG Prime. Rate-limited like any other credential endpoint —
// it mints a session, so it is one.
router.post('/exchange', credentialLimiter, validate(exchangeSchema), ctrl.exchange);
router.post('/refresh', ctrl.refresh);
router.post('/logout', requireAuth, ctrl.logout);

router.post('/password/reset-request', credentialLimiter, validate(resetRequestSchema), ctrl.requestPasswordReset);
router.post('/password/reset', credentialLimiter, validate(resetSchema), ctrl.resetPassword);
router.post('/password/change', requireAuth, validate(changePasswordSchema), ctrl.changePassword);

router.get('/me', requireAuth, ctrl.me);
router.patch('/me', requireAuth, validate(updateMeSchema), ctrl.updateMe);
router.post('/me/photo', requireAuth, upload.single('photo'), ctrl.uploadPhoto);

export default router;
