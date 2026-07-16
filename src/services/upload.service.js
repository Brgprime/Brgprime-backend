import { v2 as cloudinary } from 'cloudinary';
import { features } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

// Cloudinary auto-configures from the CLOUDINARY_URL environment variable
// (cloudinary://<api_key>:<api_secret>@<cloud_name>).
if (features.uploads) {
  cloudinary.config({ secure: true });
}

// Upload a single image buffer to Cloudinary, returns the secure public URL.
export function uploadImage(file, { prefix = 'listings' } = {}) {
  if (!features.uploads) {
    throw new ApiError(503, 'Uploads are not configured. Set CLOUDINARY_URL.');
  }
  if (!file.mimetype?.startsWith('image/')) {
    throw ApiError.badRequest('Only image files are allowed.');
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: `brg-prime/${prefix}`, resource_type: 'image' },
      (err, result) => {
        if (err || !result) {
          reject(new ApiError(400, 'Image upload failed.'));
        } else {
          resolve(result.secure_url);
        }
      }
    );
    stream.end(file.buffer);
  });
}
