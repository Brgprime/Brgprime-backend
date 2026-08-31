import { z } from 'zod';
import { UNITS } from '../lib/units.js';
import { SECTION_ORDER } from '../lib/codes.js';

// Validation rules are §8. Where the frontend already enforces something, the
// server enforces the same thing — the browser is not a validator.

const PROJECT_TYPES = ['Residential', 'Commercial', 'Industrial', 'Renovation', 'Infrastructure'];
const PROJECT_STATUSES = ['In Progress', 'Tender', 'Completed', 'On Hold'];
const MEASUREMENT_TYPES = ['Linear', 'Area', 'Volume', 'Count'];
const RATE_CATEGORIES = ['Materials', 'Labour', 'Equipment'];
const VARIATION_STATUSES = ['Pending', 'Approved', 'Rejected'];

const money = z.number().int().min(0, 'Cannot be negative.');
const unit = z.string().trim().min(1, 'Unit is required.');

// ─── Projects ────────────────────────────────────────────────────────────────
export const createProjectSchema = z.object({
  name: z.string().trim().min(1, 'Project name is required.'),
  client: z.string().trim().min(1, 'Client is required.'),
  location: z.string().trim().default(''),
  type: z.enum(PROJECT_TYPES).default('Residential'),
  status: z.enum(PROJECT_STATUSES).default('Tender'),
  budget: money.default(0),
  cover: z.string().trim().default(''),
});

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1, 'Project name is required.').optional(),
    client: z.string().trim().min(1, 'Client is required.').optional(),
    location: z.string().trim().optional(),
    type: z.enum(PROJECT_TYPES).optional(),
    status: z.enum(PROJECT_STATUSES).optional(),
    progress: z.number().int().min(0).max(100).optional(),
    budget: money.optional(),
    spent: money.optional(),
    cover: z.string().trim().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });

// ─── Documents ───────────────────────────────────────────────────────────────
export const renameDocumentSchema = z.object({
  name: z.string().trim().min(1, 'A name is required.'),
});

// ─── BOQ ─────────────────────────────────────────────────────────────────────
export const boqItemSchema = z.object({
  desc: z.string().trim().min(1, 'Description is required.'),
  section: z.string().trim().default(SECTION_ORDER[0]),
  unit,
  qty: z.number().positive('Quantity must be greater than zero.'),
  rate: money.default(0),
  sources: z.array(z.string()).default([]),
});

export const updateBoqItemSchema = z
  .object({
    desc: z.string().trim().min(1, 'Description is required.').optional(),
    section: z.string().trim().optional(),
    unit: unit.optional(),
    qty: z.number().positive('Quantity must be greater than zero.').optional(),
    rate: money.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });

export const importBoqSchema = z.object({
  measurementIds: z.array(z.string()).optional(),
  region: z.string().trim().default('Lagos'),
});

// ─── Takeoff measurements ────────────────────────────────────────────────────
export const measurementSchema = z.object({
  name: z.string().trim().min(1, 'A name is required.'),
  type: z.enum(MEASUREMENT_TYPES),
  value: z.number().min(0, 'Cannot be negative.'),
  unit: unit.optional(),
  color: z.string().trim().optional(),
});

export const updateMeasurementSchema = z
  .object({
    name: z.string().trim().min(1, 'A name is required.').optional(),
    type: z.enum(MEASUREMENT_TYPES).optional(),
    value: z.number().min(0, 'Cannot be negative.').optional(),
    unit: unit.optional(),
    color: z.string().trim().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });

// ─── Variations ──────────────────────────────────────────────────────────────
// §8 collects a non-negative magnitude plus a direction; §6 stores it signed.
//
// VariationsView.vue sends "add" / "omit"; the spec writes them out as
// "addition" / "omission". Both are accepted and normalised to the long form so
// the controller has one vocabulary to sign against.
const direction = z
  .enum(['addition', 'omission', 'add', 'omit'])
  .transform((d) => (d === 'add' ? 'addition' : d === 'omit' ? 'omission' : d));

export const createVariationSchema = z.object({
  title: z.string().trim().min(1, 'A title is required.'),
  description: z.string().trim().min(1, 'Description is required.'),
  impact: z.number().min(0, 'Enter the cost impact as a positive figure.'),
  direction: direction.default('addition'),
  revisionFrom: z.number().int().positive().optional(),
  revisionTo: z.number().int().positive().optional(),
});

export const updateVariationSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    impact: z.number().min(0).optional(),
    direction: direction.optional(),
    status: z.enum(VARIATION_STATUSES).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });

// ─── Rates ───────────────────────────────────────────────────────────────────
export const createRateSchema = z.object({
  name: z.string().trim().min(1, 'A name is required.'),
  cat: z.enum(RATE_CATEGORIES).default('Materials'),
  unit,
  rate: z.number().int().positive('Rate must be greater than zero.'),
  region: z.string().trim().default('Lagos'),
  source: z.string().trim().default('Entered by hand'),
});

export const updateRateSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    cat: z.enum(RATE_CATEGORIES).optional(),
    unit: unit.optional(),
    rate: z.number().int().positive('Rate must be greater than zero.').optional(),
    region: z.string().trim().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });

export const rateQuerySchema = z.object({
  region: z.string().trim().optional(),
  cat: z.enum(RATE_CATEGORIES).optional(),
  q: z.string().trim().optional(),
  scope: z.enum(['all', 'global', 'organization']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ─── Listing / pagination ────────────────────────────────────────────────────
export const listQuerySchema = z.object({
  q: z.string().trim().optional(),
  status: z.string().trim().optional(),
  sort: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const estimateQuerySchema = z.object({
  region: z.string().trim().default('Lagos'),
});

// A firm's own imported cost line, corrected in place.
export const updateCostLineSchema = z
  .object({
    item: z.string().trim().min(1, 'A description is required.').optional(),
    unit: unit.optional(),
    rate: money.optional(),
    qty: z.number().min(0, 'Cannot be negative.').optional(),
    section: z.string().trim().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });

// Exported so controllers can reject a unit the app cannot price against.
export const KNOWN_UNITS = Object.keys(UNITS);
