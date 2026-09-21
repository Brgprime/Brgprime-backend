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

// What this app is willing to accept.
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

// What the storage account will actually accept, which is the smaller number
// and the one that decides. Cloudinary enforces a per-asset ceiling by PLAN —
// 10 MB for raw files on the free tier — and it applies at their API, so it is
// not something this service can upload its way around. A direct-from-browser
// signed upload would not help: the same cap sits behind it.
//
// It used to be invisible. The dropzone promised 25 MB, the request was refused
// at 10, and the refusal arrived as "Upload failed. Please try again." — so the
// real ceiling could only be found by shrinking a drawing until it went
// through, losing the raster detail the engine reads.
//
// Set BUILDQ_STORAGE_MAX_MB to whatever the account's plan allows. Raising the
// plan without raising this changes nothing; raising this without raising the
// plan just moves the same rejection back to Cloudinary.
const PROVIDER_MAX_MB = Number(process.env.BUILDQ_STORAGE_MAX_MB || 10);

/** The ceiling that actually applies. Advertise THIS, never MAX_FILE_BYTES. */
export const EFFECTIVE_MAX_BYTES = Math.min(
  MAX_FILE_BYTES,
  Math.max(1, PROVIDER_MAX_MB) * 1024 * 1024
);

export const EFFECTIVE_MAX_MB = Math.floor(EFFECTIVE_MAX_BYTES / (1024 * 1024));

/** What the dropzone should tell the user, so the two cannot drift apart. */
export function uploadLimits() {
  return {
    maxBytes: EFFECTIVE_MAX_BYTES,
    maxMb: EFFECTIVE_MAX_MB,
    // True when the storage plan, not this app, is what caps uploads — the
    // case where the fix is a billing decision rather than a code change.
    cappedByProvider: EFFECTIVE_MAX_BYTES < MAX_FILE_BYTES,
    appMaxMb: Math.floor(MAX_FILE_BYTES / (1024 * 1024)),
    acceptedTypes: [...ACCEPTED_EXT].map((e) => `.${e}`).join(','),
  };
}

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

  // Refuse here rather than after pushing the bytes at a provider that will
  // refuse them anyway. Same outcome, no wasted upload, and a message that
  // names the real number.
  if (file.size > EFFECTIVE_MAX_BYTES) {
    throw BuildqError.badRequest(
      `"${file.originalname}" is ${(file.size / (1024 * 1024)).toFixed(1)} MB. The file storage plan caps uploads at ${EFFECTIVE_MAX_MB} MB.`,
      undefined,
      'file_too_large'
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
          reject(uploadFailure(err, file));
        } else {
          resolve({ storageKey: result.public_id, storageUrl: result.secure_url, bytes: result.bytes });
        }
      }
    );
    stream.end(file.buffer);
  });
}

// Why an upload actually failed.
//
// This used to be a flat "Upload failed. Please try again." for every cause,
// and retrying does not help when the file is simply too big — so a surveyor
// met a 25 MB dropzone, was refused at 10 MB, and had to discover the real
// ceiling by shrinking the file until it went through. Losing raster detail the
// engine needs to read, to satisfy a limit nothing stated.
//
// The storage account's own per-file cap is what bites first: it sits BELOW the
// 25 MB this service accepts, and neither this code nor the dropzone knows its
// value until the provider objects. So we relay what the provider said.
function uploadFailure(err, file) {
  const message = String(err?.message || '');
  const status = err?.http_code || err?.error?.http_code;

  // e.g. "File size too large. Got 13421772. Maximum is 10485760."
  const tooLarge = /file size too large|maximum is \d+/i.test(message);
  if (tooLarge) {
    const max = message.match(/maximum is (\d+)/i);
    const cap = max ? `${(Number(max[1]) / (1024 * 1024)).toFixed(0)} MB` : 'a lower limit';
    const got = file?.size ? ` "${file.originalname}" is ${(file.size / (1024 * 1024)).toFixed(1)} MB.` : '';
    return BuildqError.badRequest(
      `The file storage account caps uploads at ${cap}, which is below this app's ${Math.round(
        MAX_FILE_BYTES / (1024 * 1024)
      )} MB limit.${got} Raise the storage plan's per-file limit, or split the drawing set into separate sheets — shrinking the file costs the engine the detail it reads.`,
      undefined,
      'file_too_large'
    );
  }

  if (status === 401 || status === 403) {
    return BuildqError.unavailable(
      'File storage rejected the credentials. Check CLOUDINARY_URL.',
      'storage_unauthorized'
    );
  }

  return BuildqError.badRequest(
    message ? `Upload failed: ${message}` : 'Upload failed. Please try again.',
    undefined,
    'upload_failed'
  );
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
          reject(uploadFailure(err, file));
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
