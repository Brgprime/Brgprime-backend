import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/respond.js';
import { nigerianLocations, majorCities, popularLocations } from '../config/locations.js';

// GET /api/meta/locations
export const getLocations = asyncHandler(async (_req, res) => {
  return ok(res, { nigerianLocations, majorCities, popularLocations });
});

// GET /api/meta/dashboard-stats — the static stat cards on the dashboard/landing.
export const getDashboardStats = asyncHandler(async (_req, res) => {
  return ok(res, {
    stats: [
      { label: 'Active Listings', value: '12,400+' },
      { label: 'Happy Users', value: '5,200+' },
      { label: 'Agents & Sellers', value: '850+' },
      { label: 'Locations', value: '36' },
    ],
    popularLocations,
  });
});
