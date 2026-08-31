import { prisma } from '../../../config/prisma.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { BuildqError } from '../lib/errors.js';
import { serializeDocument } from '../lib/serializers.js';
import { recordActivity } from '../middleware/scope.js';
import {
  uploadDocument,
  destroy,
  signedUrl,
  extensionOf,
  kindOf,
  isDrawing,
  isAnalysable,
  fetchBuffer,
} from '../services/storage.service.js';
import { signFileToken, verifyBuildqToken } from '../lib/jwt.js';
import { buildqFeatures } from '../config.js';

const withRelations = {
  project: true,
  uploadedBy: true,
  _count: { select: { elements: true } },
};

// POST /projects/:projectId/documents — multipart upload.
//
// The response carries an analysis job id only when the file is one the engine
// can actually read. For DWG/RVT/IFC the document is stored and previewable but
// reported as un-analysable — the alternative (a template keyed off the
// filename) is what makes the same drawing worth ₦54.1M or ₦8.5M depending on
// what it is called.
export const upload = asyncHandler(async (req, res) => {
  if (!req.file) throw BuildqError.badRequest('Attach a file to upload.', { file: 'Required.' });

  const ext = extensionOf(req.file.originalname);
  const kind = kindOf(ext);
  const analysable = isDrawing(kind) && isAnalysable(ext);

  const { storageKey, storageUrl, bytes } = await uploadDocument(req.file, {
    orgId: req.buildqUser.orgId,
  });

  const document = await prisma.buildqDocument.create({
    data: {
      orgId: req.buildqUser.orgId,
      projectId: req.project.id,
      name: req.file.originalname,
      ext,
      kind,
      sizeBytes: bytes ?? req.file.size ?? 0,
      mime: req.file.mimetype || '',
      storageKey,
      storageUrl,
      uploadedById: req.buildqUser.id,
      // Only claim to be analysing when a worker can actually pick the job up.
      // With no ANTHROPIC_API_KEY the queue never starts, and a document left
      // on 'Analyzing' spins in the UI forever for work that will never run.
      status: analysable ? (buildqFeatures.ai ? 'Analyzing' : 'Pending') : 'Ready',
    },
    include: withRelations,
  });

  // Queued here; the worker that drains this table arrives with the engine.
  let job = null;
  if (analysable) {
    job = await prisma.buildqAnalysisJob.create({
      data: { documentId: document.id, status: 'queued' },
    });
  }

  await recordActivity({
    orgId: req.buildqUser.orgId,
    projectId: req.project.id,
    actorId: req.buildqUser.id,
    action: 'uploaded',
    target: document.name,
    type: 'upload',
  });

  res.status(201).json({
    document: serializeDocument(document),
    analysisJobId: job?.id ?? null,
    analysable,
    ...(analysable
      ? {}
      : {
          notice: isDrawing(kind)
            ? `.${ext} files cannot be read by the analysis engine. The file is stored and can be downloaded, but no quantities will be measured from it.`
            : `This file is kept as a ${kind.toLowerCase()}; only drawings are analysed.`,
        }),
  });
});

// GET /projects/:projectId/documents
export const listForProject = asyncHandler(async (req, res) => {
  const documents = await prisma.buildqDocument.findMany({
    where: { orgId: req.buildqUser.orgId, projectId: req.project.id },
    include: withRelations,
    orderBy: { uploadedAt: 'desc' },
  });
  res.json({ documents: documents.map(serializeDocument) });
});

// GET /documents/:documentId
export const get = asyncHandler(async (req, res) => {
  const [job, elements] = await Promise.all([
    prisma.buildqAnalysisJob.findFirst({
      where: { documentId: req.document.id },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.buildqDetectedElement.findMany({ where: { documentId: req.document.id } }),
  ]);

  res.json({
    document: serializeDocument(req.document),
    analysis: job
      ? { id: job.id, status: job.status, error: job.error, finishedAt: job.finishedAt }
      : null,
    elements: elements.map((e) => ({
      type: e.type,
      count: e.count,
      length: e.length,
      area: e.area,
      volume: e.volume,
      unit: e.unit,
      confidence: e.confidence,
    })),
  });
});

// GET /documents/:documentId/download — short-lived signed URL.
export const download = asyncHandler(async (req, res) => {
  const url = signedUrl(req.document.storageKey, { seconds: 300 });
  res.json({ url, expiresIn: 300, name: req.document.name });
});

// GET /documents/:documentId/preview
// Images are their own preview. For everything else there is no server-side
// renderer, so this reports that plainly rather than returning a broken link.
export const preview = asyncHandler(async (req, res) => {
  // The bytes are streamed by /documents/:id/inline below rather than handing
  // out a Cloudinary link: that link arrives as Content-Disposition: attachment
  // and application/octet-stream, so a browser downloads it instead of showing
  // it — which broke both the preview button and the in-page drawing viewers.
  const inline = (kind) => {
    const token = signFileToken({ documentId: req.document.id, orgId: req.document.orgId });
    // Relative to the API root, not to a host: the client joins it onto
    // whatever base it is configured with, so this keeps working if the API
    // ever moves to its own origin.
    return res.json({
      url: `/documents/${req.document.id}/inline?t=${encodeURIComponent(token)}`,
      kind,
      relative: true,
    });
  };

  if (req.document.kind === 'Image') return inline('image');
  if (req.document.ext === 'pdf') return inline('pdf');

  res.json({
    url: null,
    kind: 'none',
    notice: `No preview is available for .${req.document.ext} files.`,
  });
});

// GET /documents/:documentId/inline?t=… — the bytes, rendered in place.
//
// Public by route, but useless without a file token that names this exact
// document and expires in five minutes. <img> and <iframe> cannot send an
// Authorization header, which is the whole reason this exists.
export const inlineBytes = asyncHandler(async (req, res) => {
  let payload;
  try {
    payload = verifyBuildqToken(String(req.query.t || ''), 'file');
  } catch {
    throw BuildqError.unauthorized('This preview link has expired. Reopen the document.', 'preview_expired');
  }
  if (payload.sub !== req.params.documentId) {
    throw BuildqError.unauthorized('That preview link is not for this document.', 'preview_mismatch');
  }

  const document = await prisma.buildqDocument.findFirst({
    where: { id: req.params.documentId, orgId: payload.org },
  });
  if (!document) throw BuildqError.notFound('That document does not exist.', 'document_not_found');

  const buffer = await fetchBuffer(signedUrl(document.storageKey, { seconds: 120 }));

  res.setHeader('Content-Type', document.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${document.name.replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'private, max-age=120');
  res.send(buffer);
});

// PATCH /documents/:documentId — rename.
export const rename = asyncHandler(async (req, res) => {
  const document = await prisma.buildqDocument.update({
    where: { id: req.document.id },
    data: { name: req.body.name },
    include: withRelations,
  });
  res.json({ document: serializeDocument(document) });
});

// DELETE /documents/:documentId
export const remove = asyncHandler(async (req, res) => {
  await prisma.buildqDocument.delete({ where: { id: req.document.id } });
  // Storage cleanup is best-effort and must not fail the request.
  destroy(req.document.storageKey);

  await recordActivity({
    orgId: req.buildqUser.orgId,
    projectId: req.document.projectId,
    actorId: req.buildqUser.id,
    action: 'deleted document',
    target: req.document.name,
    type: 'warning',
  });

  res.json({ ok: true });
});
