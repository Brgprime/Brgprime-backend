import { v2 as cloudinary } from 'cloudinary';
import { buildqFeatures } from '../config.js';
import { BuildqError } from '../lib/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// File storage for BuildQ.
//
// The same Cloudinary account as BRG Prime (auto-configured from CLOUDINARY_URL)
// under a separate `buildq/` folder. BRG Prime's upload.service.js is left
// untouched: it only accepts images and uploads with resource_type "image",
// which would corrupt a PDF or DXF. Drawings go up as "raw" instead.
//
// This is what replaces the S3_BUCKET / S3_* variables the spec asks for.
// ─────────────────────────────────────────────────────────────────────────────

if (buildqFeatures.storage) {
  cloudinary.config({ secure: true });
}

// What the analysis engine can actually read today. DWG and RVT are proprietary
// binaries that need a converter we deliberately do not run, so they are stored
// and previewed but reported as un-analysable rather than silently guessed at.
export const ANALYSABLE_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
]);

export const ANALYSABLE_EXT = new Set(['pdf', 'png', 'jpg', 'jpeg', 'dxf']);

// ACCEPTED_TYPES and MAX_FILE_MB, matched to the frontend dropzone exactly —
// a file the browser accepts must not be rejected by the server.
const ACCEPTED_EXT = new Set([
  'pdf', 'dwg', 'dxf', 'rvt', 'ifc',
  'png', 'jpg', 'jpeg',
  'xlsx', 'xls', 'csv',
  'docx', 'doc',
]);

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

// Documents are stored under authenticated delivery; avatars stay public
// because they are rendered in ordinary <img> tags all over the app.
export const DOCUMENT_TYPE = 'authenticated';

export function extensionOf(filename = '') {
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

// Extension → kind, using the frontend's own vocabulary (spec §6). Note CAD is
// a separate kind from Drawing: only pdf is "Drawing".
const KIND_BY_EXT = {
  pdf: 'Drawing',
  dwg: 'CAD',
  dxf: 'CAD',
  rvt: 'BIM',
  ifc: 'BIM',
  png: 'Image',
  jpg: 'Image',
  jpeg: 'Image',
  xlsx: 'Spreadsheet',
  xls: 'Spreadsheet',
  csv: 'Spreadsheet',
  docx: 'Document',
  doc: 'Document',
};

export function kindOf(ext) {
  return KIND_BY_EXT[ext] || 'File';
}

// Only these kinds are eligible for analysis and BOQ generation (spec §6).
const DRAWING_KINDS = new Set(['Drawing', 'CAD', 'BIM', 'Image']);

export function isDrawing(kind) {
  return DRAWING_KINDS.has(kind);
}

// Whether the engine can actually read this file today. DWG and RVT are
// proprietary binaries needing a converter we do not run, and IFC needs a
// parser we have not built — they are stored and previewed, never guessed at.
export function isAnalysable(ext) {
  return ANALYSABLE_EXT.has(ext);
}

function ensureConfigured() {
  if (!buildqFeatures.storage) {
    throw BuildqError.unavailable('File storage is not configured. Set CLOUDINARY_URL.', 'storage_unconfigured');
  }
}

// Upload a drawing/document buffer. Returns { storageKey, storageUrl, bytes }.
export function uploadDocument(file, { orgId }) {
  ensureConfigured();

  const ext = extensionOf(file.originalname);
  if (!ACCEPTED_EXT.has(ext)) {
    throw BuildqError.badRequest(
      `Unsupported file type ".${ext}". Accepted: ${[...ACCEPTED_EXT].join(', ')}.`,
      undefined,
      'unsupported_file_type'
    );
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `buildq/${orgId}/documents`,
        resource_type: 'raw',
        // Authenticated delivery. A default "upload" asset is served from a
        // permanent public URL that needs no credential — anyone holding the
        // link, forever. Drawings and bills are a firm's commercial position,
        // so the delivery URL has to be signed, and signedUrl() below is the
        // only way to obtain one.
        type: DOCUMENT_TYPE,
        use_filename: true,
        unique_filename: true,
      },
      (err, result) => {
        if (err || !result) {
          reject(BuildqError.badRequest('Upload failed. Please try again.', undefined, 'upload_failed'));
        } else {
          resolve({ storageKey: result.public_id, storageUrl: result.secure_url, bytes: result.bytes });
        }
      }
    );
    stream.end(file.buffer);
  });
}

// Avatars and other images.
export function uploadImage(file, { orgId, prefix = 'avatars' }) {
  ensureConfigured();
  if (!file.mimetype?.startsWith('image/')) {
    throw BuildqError.badRequest('Only image files are allowed.', undefined, 'not_an_image');
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: `buildq/${orgId}/${prefix}`, resource_type: 'image' },
      (err, result) => {
        if (err || !result) {
          reject(BuildqError.badRequest('Image upload failed.', undefined, 'upload_failed'));
        } else {
          resolve({ storageKey: result.public_id, storageUrl: result.secure_url });
        }
      }
    );
    stream.end(file.buffer);
  });
}

// Time-limited link to a stored document. This is the ONLY way to read one:
// the asset is not reachable without the signature, and the signature expires.
export function signedUrl(storageKey, { resourceType = 'raw', seconds = 300 } = {}) {
  ensureConfigured();
  return cloudinary.utils.private_download_url(storageKey, '', {
    resource_type: resourceType,
    type: DOCUMENT_TYPE,
    expires_at: Math.floor(Date.now() / 1000) + seconds,
  });
}

export async function destroy(storageKey, { resourceType = 'raw', type = DOCUMENT_TYPE } = {}) {
  if (!buildqFeatures.storage || !storageKey) return;
  try {
    await cloudinary.uploader.destroy(storageKey, { resource_type: resourceType, type });
  } catch (err) {
    console.error('[buildq] Cloudinary destroy failed:', err?.message || err);
  }
}

// Fetch the stored bytes back so the analysis engine can read them.
export async function fetchBuffer(storageUrl) {
  const res = await fetch(storageUrl);
  if (!res.ok) {
    throw BuildqError.badRequest(`Could not read the stored file (${res.status}).`, undefined, 'storage_read_failed');
  }
  return Buffer.from(await res.arrayBuffer());
}
