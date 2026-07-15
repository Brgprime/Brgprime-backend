import { z } from 'zod';

const LISTING_TYPES = [
  'rent', 'sale', 'lease', 'shortlet', 'commercialRent',
  'commercialSale', 'land', 'landLease', 'jointVenture',
];

// Frontend "tab" → listingType map (from the property store).
export const TAB_TO_TYPE = {
  Buy: 'sale',
  Sell: 'sale',
  Rent: 'rent',
  Lease: 'lease',
  Shortlet: 'shortlet',
  Commercial: 'commercialRent',
  Land: 'land',
  'New Dev': 'sale',
};

const numeric = z.coerce.number();

export const listPropertiesSchema = z.object({
  search: z.string().trim().optional(),
  q: z.string().trim().optional(),
  location: z.string().trim().optional(),
  tab: z.string().trim().optional(),
  listingType: z.enum(LISTING_TYPES).optional(),
  propertyType: z.string().trim().optional(),
  minPrice: numeric.optional(),
  maxPrice: numeric.optional(),
  bedrooms: z.union([z.coerce.number(), z.literal('Any')]).optional(),
  bathrooms: z.union([z.coerce.number(), z.literal('Any')]).optional(),
  verifiedOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
  featured: z.enum(['true', 'false']).optional(),
  recent: z.enum(['true', 'false']).optional(),
  mine: z.enum(['true', 'false']).optional(),
  saved: z.enum(['true', 'false']).optional(),
  sort: z.enum(['relevance', 'newest', 'priceAsc', 'priceDesc']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const createPropertySchema = z.object({
  title: z.string().trim().min(1, 'Please fill in all required fields.'),
  address: z.string().trim().min(1, 'Please fill in all required fields.'),
  price: z.coerce.number().positive('Please fill in all required fields.'),
  listingType: z.enum(LISTING_TYPES).default('rent'),
  propertyType: z.string().trim().default('apartment'),
  description: z.string().trim().max(1000).optional().default(''),
  bedrooms: z.coerce.number().int().min(0).optional().default(0),
  bathrooms: z.coerce.number().int().min(0).optional().default(0),
  size: z.coerce.number().min(0).optional().default(0),
  yearBuilt: z.coerce.number().int().nullable().optional(),
  furnishingStatus: z.string().trim().optional().default('Unfurnished'),
  propertyCondition: z.string().trim().optional().default('Good'),
  amenities: z.array(z.string()).optional().default([]),
  images: z.array(z.string()).optional().default([]),
  isPremium: z.boolean().optional().default(false),
  isBoosted: z.boolean().optional().default(false),
});

export const updatePropertySchema = createPropertySchema.partial().extend({
  status: z.enum(['Active', 'Pending', 'Sold']).optional(),
});
