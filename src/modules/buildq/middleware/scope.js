import { prisma } from '../../../config/prisma.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { BuildqError } from '../lib/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Organization scoping.
//
// "No per-organization isolation" is listed as a Critical hole in §16. Every
// lookup here is filtered by the caller's orgId, so a valid token for org A
// cannot reach org B's data by guessing an id — the row simply is not found.
// Controllers must load projects and documents through these, never directly.
// ─────────────────────────────────────────────────────────────────────────────

// Accepts either the public code (PRJ-1042) or the surrogate id.
export const loadProject = (param = 'projectId') =>
  asyncHandler(async (req, _res, next) => {
    const key = req.params[param];
    if (!key) throw BuildqError.badRequest('No project specified.');

    const project = await prisma.buildqProject.findFirst({
      where: { orgId: req.buildqUser.orgId, OR: [{ code: key }, { id: key }] },
      include: { members: { include: { user: true } } },
    });

    // Deliberately 404 rather than 403: a caller should not learn that a
    // project exists in someone else's organization.
    if (!project) throw BuildqError.notFound('That project does not exist.', 'project_not_found');

    req.project = project;
    next();
  });

export const loadDocument = (param = 'documentId') =>
  asyncHandler(async (req, _res, next) => {
    const key = req.params[param];
    if (!key) throw BuildqError.badRequest('No document specified.');

    const document = await prisma.buildqDocument.findFirst({
      where: { orgId: req.buildqUser.orgId, id: key },
      include: { project: true, uploadedBy: true, _count: { select: { elements: true } } },
    });

    if (!document) throw BuildqError.notFound('That document does not exist.', 'document_not_found');

    req.document = document;
    next();
  });

// Records an audit entry. §16 lists "No audit trail" as an open issue; every
// mutating controller calls this. Never throws — an audit failure must not
// fail the operation it was recording.
export async function recordActivity({ orgId, projectId = null, actorId = null, action, target = '', type = 'info' }) {
  try {
    await prisma.buildqActivityEvent.create({
      data: { orgId, projectId, actorId, action, target, type },
    });
  } catch (err) {
    console.error('[buildq] activity log failed:', err?.message || err);
  }
}
