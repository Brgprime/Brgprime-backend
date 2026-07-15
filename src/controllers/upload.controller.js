import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ok, created } from '../utils/respond.js';
import { uploadImage } from '../services/upload.service.js';
import { features } from '../config/env.js';

// GET /api/uploads/config — whether uploads are available.
export const config = asyncHandler(async (_req, res) => {
  return ok(res, { enabled: features.uploads });
});

// POST /api/uploads/image — single image (field name: "image").
export const uploadSingle = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('No image provided (field "image").');
  const url = await uploadImage(req.file, { prefix: req.body.prefix || 'listings' });
  return created(res, { url });
});

// POST /api/uploads/images — up to 10 images (field name: "images").
export const uploadMany = asyncHandler(async (req, res) => {
  if (!req.files || !req.files.length) {
    throw ApiError.badRequest('No images provided (field "images").');
  }
  const urls = await Promise.all(
    req.files.map((f) => uploadImage(f, { prefix: req.body.prefix || 'listings' }))
  );
  return created(res, { urls });
});
