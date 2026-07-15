import crypto from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { env, features } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

// Cloudflare R2 is S3-compatible — point the AWS SDK at the R2 endpoint.
let client = null;
if (features.uploads) {
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${env.r2.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.r2.accessKeyId,
      secretAccessKey: env.r2.secretAccessKey,
    },
  });
}

const EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

// Upload a single buffer to R2, returns the public URL.
export async function uploadImage(file, { prefix = 'listings' } = {}) {
  if (!features.uploads) {
    throw new ApiError(503, 'Uploads are not configured. Set the R2_* environment variables.');
  }
  const ext = EXT[file.mimetype];
  if (!ext) throw ApiError.badRequest('Unsupported image type. Use JPG, PNG, WEBP, GIF or AVIF.');

  const key = `${prefix}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;

  await client.send(
    new PutObjectCommand({
      Bucket: env.r2.bucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );

  return `${env.r2.publicUrl}/${key}`;
}
