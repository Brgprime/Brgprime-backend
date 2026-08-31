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
} from '../services/storage.service.js';

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
      status: analysable ? 'Analyzing' : 'Ready',
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
  // Documents are stored under authenticated delivery, so even an image has to
  // be signed — storageUrl on its own no longer resolves.
  if (req.document.kind === 'Image') {
    return res.json({ url: signedUrl(req.document.storageKey, { seconds: 300 }), kind: 'image' });
  }
  if (req.document.ext === 'pdf') {
    return res.json({ url: signedUrl(req.document.storageKey, { seconds: 300 }), kind: 'pdf' });
  }
  res.json({
    url: null,
    kind: 'none',
    notice: `No preview is available for .${req.document.ext} files.`,
  });
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
