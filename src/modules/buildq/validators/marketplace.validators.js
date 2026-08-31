import { z } from 'zod';
import { ROLES, PLANS } from '../config.js';

// Validation rules are §8. The frontend already enforces these; so does the
// server, because a browser is not a validator.

const phone = z
  .string()
  .trim()
  .regex(/^[+\d][\d\s-]{7,}$/, 'Enter a valid phone number.');

const email = z.string().trim().toLowerCase().email('Enter a valid email address.');

const product = z.object({
  name: z.string().trim().min(1, 'Product name is required.'),
  unit: z.string().trim().min(1, 'Unit is required.'),
  price: z.number().int().positive('Price must be greater than zero.'),
});

// ─── Vendors ─────────────────────────────────────────────────────────────────
export const createVendorSchema = z.object({
  name: z.string().trim().min(3, 'Business name must be at least 3 characters.'),
  category: z.string().trim().min(1, 'Choose a category.'),
  location: z.string().trim().min(1, 'Location is required.'),
  phone,
  email,
  whatsapp: z.string().trim().optional(),
  years: z.number().int().min(0).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  unlockPrice: z.number().int().min(0).max(100000).optional(),
  products: z.array(product).min(1, 'Add at least one product.'),
});

export const updateVendorSchema = z
  .object({
    name: z.string().trim().min(3, 'Business name must be at least 3 characters.').optional(),
    category: z.string().trim().optional(),
    location: z.string().trim().min(1).optional(),
    phone: phone.optional(),
    email: email.optional(),
    whatsapp: z.string().trim().optional(),
    years: z.number().int().min(0).max(200).optional(),
    description: z.string().trim().max(2000).optional(),
    unlockPrice: z.number().int().min(0).max(100000).optional(),
    products: z.array(product).min(1, 'Add at least one product.').optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });

export const unlockVendorSchema = z.object({
  reference: z.string().trim().min(4).optional(),
});

export const savePriceSchema = z.object({
  vendorId: z.string().trim().min(1, 'A vendor is required.'),
  productName: z.string().trim().min(1, 'A product is required.'),
  unit: z.string().trim().min(1, 'Unit is required.'),
  rate: z.number().int().positive('Rate must be greater than zero.'),
});

// ─── Team ────────────────────────────────────────────────────────────────────
export const inviteSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.'),
  email,
  role: z.enum(ROLES, { errorMap: () => ({ message: 'Choose a valid role.' }) }),
});

export const lookupInviteSchema = z.object({
  token: z.string().trim().min(10, 'This invitation link is not valid.'),
});

export const acceptInviteSchema = z.object({
  token: z.string().trim().min(10, 'This invitation link is not valid.'),
  name: z.string().trim().min(2, 'Enter your full name.').optional(),
  password: z
    .string()
    .min(8, 'Use at least 8 characters.')
    .regex(/[A-Z]/, 'Include an uppercase letter.')
    .regex(/[0-9]/, 'Include a number.')
    .regex(/[^A-Za-z0-9]/, 'Include a symbol.'),
});

export const updateMemberSchema = z.object({
  role: z.enum(ROLES, { errorMap: () => ({ message: 'Choose a valid role.' }) }),
});

// ─── Billing & payments ──────────────────────────────────────────────────────
export const subscribeSchema = z.object({
  plan: z.enum(Object.keys(PLANS), { errorMap: () => ({ message: 'Choose a valid plan.' }) }),
  reference: z.string().trim().min(4).optional(),
});

export const verifyPaymentSchema = z.object({
  reference: z.string().trim().min(4, 'A payment reference is required.'),
});

// ─── Reports ─────────────────────────────────────────────────────────────────
export const generateReportSchema = z.object({
  projectId: z.string().trim().min(1, 'A project is required.'),
  type: z.enum(['boq', 'cost-summary']).default('boq'),
});
