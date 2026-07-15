import { z } from 'zod';

export const registerSchema = z.object({
  firstName: z.string().trim().min(1, 'First name is required').optional(),
  lastName: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  email: z.string().trim().toLowerCase().email('A valid email is required'),
  phone: z.string().trim().min(6, 'A valid phone number is required'),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
}).refine((d) => d.name || d.firstName, {
  message: 'Name is required',
  path: ['name'],
});

export const verifyOtpSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.'),
});

export const resendOtpSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('A valid email is required'),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email('A valid email is required'),
});

export const resetPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email('A valid email is required'),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters.'),
});

export const updateProfileSchema = z.object({
  name: z.string().trim().min(1).optional(),
  firstName: z.string().trim().optional(),
  lastName: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  bio: z.string().trim().max(500).optional(),
  profileImageUrl: z.string().trim().optional(),
  avatarUrl: z.string().trim().optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters.'),
});
