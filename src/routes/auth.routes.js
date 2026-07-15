import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as ctrl from '../controllers/auth.controller.js';
import {
  registerSchema, verifyOtpSchema, resendOtpSchema,
  loginSchema, forgotPasswordSchema, resetPasswordSchema,
} from '../validators/auth.validators.js';

const router = Router();

router.post('/register', validate(registerSchema), ctrl.register);
router.post('/verify-otp', validate(verifyOtpSchema), ctrl.verifyOtp);
router.post('/resend-otp', validate(resendOtpSchema), ctrl.resendOtp);
router.post('/login', validate(loginSchema), ctrl.login);
router.post('/forgot-password', validate(forgotPasswordSchema), ctrl.forgotPassword);
router.post('/reset-password', validate(resetPasswordSchema), ctrl.resetPassword);
router.get('/me', requireAuth, ctrl.me);

export default router;
