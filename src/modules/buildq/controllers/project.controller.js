import { prisma } from '../../../config/prisma.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { BuildqError } from '../lib/errors.js';
import { nextProjectCode } from '../lib/codes.js';
import { serializeProject, serializeActivity } from '../lib/serializers.js';
import { recordActivity } from '../middleware/scope.js';

// Every query is filtered by the caller's orgId — see middleware/scope.js.

// GET /projects
export const list = asyncHandler(async (req, res) => {
  const { q, status, page, limit } = req.validatedQuery;
  const where = {
    orgId: req.buildqUser.orgId,
    ...(status && { status }),
    ...(q && {
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { client: { contains: q, mode: 'insensitive' } },
        { code: { contains: q, mode: 'insensitive' } },
      ],
    }),
  };

  const [rows, total] = await Promise.all([
    prisma.buildqProject.findMany({
      where,
      include: { members: { include: { user: true } } },
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.buildqProject.count({ where }),
  ]);

  res.json({
    projects: rows.map(serializeProject),
    page,
    limit,
    total,
    pages: Math.ceil(total / limit) || 1,
  });
});

// POST /projects
export const create = asyncHandler(async (req, res) => {
  const { name, client, location, type, status, budget, cover } = req.body;
  const code = await nextProjectCode(prisma);

  const project = await prisma.buildqProject.create({
    data: {
      orgId: req.buildqUser.orgId,
      code,
      name,
      client,
      location,
      type,
      status,
      budget: BigInt(budget),
      cover,
      members: { create: { userId: req.buildqUser.id, role: req.buildqUser.role } },
    },
    include: { members: { include: { user: true } } },
  });

  await recordActivity({
    orgId: req.buildqUser.orgId,
    projectId: project.id,
    actorId: req.buildqUser.id,
    action: 'created project',
    target: project.name,
    type: 'success',
  });

  res.status(201).json({ project: serializeProject(project) });
});

// GET /projects/:projectId — an unknown id 404s, never returns a different project.
export const get = asyncHandler(async (req, res) => {
  const [documents, boqRevision, variations] = await Promise.all([
    prisma.buildqDocument.count({ where: { projectId: req.project.id } }),
    prisma.buildqBoqRevision.findFirst({
      where: { projectId: req.project.id },
      orderBy: { version: 'desc' },
      include: { _count: { select: { items: true } } },
    }),
    prisma.buildqVariation.count({ where: { projectId: req.project.id } }),
  ]);

  res.json({
    project: serializeProject(req.project),
    counts: {
      documents,
      boqItems: boqRevision?._count.items ?? 0,
      boqRevision: boqRevision?.version ?? null,
      variations,
    },
  });
});

// PATCH /projects/:projectId
export const update = asyncHandler(async (req, res) => {
  const { budget, spent, ...rest } = req.body;

  const project = await prisma.buildqProject.update({
    where: { id: req.project.id },
    data: {
      ...rest,
      ...(budget !== undefined && { budget: BigInt(budget) }),
      ...(spent !== undefined && { spent: BigInt(spent) }),
    },
    include: { members: { include: { user: true } } },
  });

  await recordActivity({
    orgId: req.buildqUser.orgId,
    projectId: project.id,
    actorId: req.buildqUser.id,
    action: 'updated',
    target: project.name,
    type: 'edit',
  });

  res.json({ project: serializeProject(project) });
});

// DELETE /projects/:projectId
export const remove = asyncHandler(async (req, res) => {
  await prisma.buildqProject.delete({ where: { id: req.project.id } });
  await recordActivity({
    orgId: req.buildqUser.orgId,
    actorId: req.buildqUser.id,
    action: 'deleted project',
    target: req.project.name,
    type: 'warning',
  });
  res.json({ ok: true });
});

// GET /projects/:projectId/activity — real events, not the static array.
export const activity = asyncHandler(async (req, res) => {
  const events = await prisma.buildqActivityEvent.findMany({
    where: { projectId: req.project.id },
    include: { actor: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.json({ activity: events.map(serializeActivity) });
});

// GET /projects/:projectId/spend — monthly cumulative series.
//
// There is no spend ledger in the schema: `spent` is a single current figure.
// Rather than invent a curve, this builds the series from the only dated cost
// events that actually exist — approved variations — and says so when there is
// nothing to plot.
export const spend = asyncHandler(async (req, res) => {
  const variations = await prisma.buildqVariation.findMany({
    where: { projectId: req.project.id, status: 'Approved' },
    orderBy: { decidedAt: 'asc' },
    select: { decidedAt: true, raisedAt: true, impactNaira: true },
  });

  const byMonth = new Map();
  for (const v of variations) {
    const when = v.decidedAt || v.raisedAt;
    const key = `${when.getUTCFullYear()}-${String(when.getUTCMonth() + 1).padStart(2, '0')}`;
    byMonth.set(key, (byMonth.get(key) || 0) + Number(v.impactNaira));
  }

  let running = 0;
  const series = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, delta]) => {
      running += delta;
      return { month, delta, cumulative: running };
    });

  res.json({
    series,
    budget: Number(req.project.budget),
    spent: Number(req.project.spent),
    notes: series.length
      ? [{ type: 'info', text: 'Series is built from approved variations. Add a spend ledger for full cost history.' }]
      : [{ type: 'info', text: 'No dated spend events recorded for this project yet.' }],
  });
});
