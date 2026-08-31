import { z } from 'zod';
import { ROLES } from '../config.js';

// The signup form already scores password strength client-side; this is the
// server-side enforcement the spec asks for (§14).
const password = z
  .string()
  .min(8, 'Use at least 8 characters.')
  .regex(/[A-Z]/, 'Include an uppercase letter.')
  .regex(/[0-9]/, 'Include a number.')
  .regex(/[^A-Za-z0-9]/, 'Include a symbol.');

const email = z.string().trim().toLowerCase().email('Enter a valid email address.');

export const signupSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name.'),
  email,
  company: z.string().trim().min(2, 'Enter your company name.'),
  password,
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password.'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().optional(),
});

// A BRG Prime access token, traded for a BuildQ session at /auth/exchange.
export const exchangeSchema = z.object({
  token: z.string().trim().min(20, 'A BRG Prime session token is required.'),
});

export const resetRequestSchema = z.object({ email });

export const resetSchema = z.object({
  token: z.string().min(10, 'This reset link is not valid.'),
  password,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.'),
  newPassword: password,
});

export const updateMeSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter your full name.').optional(),
    email: email.optional(),
    phone: z.string().trim().max(32).optional(),
    company: z.string().trim().min(2, 'Enter your company name.').optional(),
    role: z.enum(ROLES).optional(),
    photoUrl: z.string().url('Enter a valid URL.').optional(),
    // Organization-wide, so only an admin may change them — enforced in the
    // controller alongside the company name.
    industry: z.string().trim().min(2).max(80).optional(),
    country: z.string().trim().min(2).max(80).optional(),
    currency: z.string().trim().min(1).max(16).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });
