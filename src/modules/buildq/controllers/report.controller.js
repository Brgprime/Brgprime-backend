import { prisma } from '../../../config/prisma.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { BuildqError } from '../lib/errors.js';
import { uploadDocument, signedUrl } from '../services/storage.service.js';
import { currentItems, totals } from '../services/boq.service.js';
import { estimate as computeEstimate } from '../services/estimation.service.js';
import { recordActivity } from '../middleware/scope.js';

const csvEscape = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ─── Reports ─────────────────────────────────────────────────────────────────

async function buildBoqReport(project) {
  const { revision, items } = await currentItems(project.id);
  const { sections, total } = totals(items);

  const rows = [
    ['BuildQ AI — Bill of Quantities'],
    [`Project`, project.name, project.code],
    [`Client`, project.client || ''],
    [`Revision`, revision ? `${revision.version} (${revision.source})` : 'none'],
    [`Generated`, new Date().toISOString()],
    [],
    ['Code', 'Description', 'Section', 'Unit', 'Qty', 'Rate', 'Amount', 'Confidence', 'Sources'],
    ...items.map((i) => [
      i.code,
      i.description,
      i.section,
      i.unit,
      i.qty,
      i.rate,
      Math.round((i.qty || 0) * (i.rate || 0)),
      i.confidence === null ? '' : Math.round(i.confidence * 100),
      (i.sources || []).join('; '),
    ]),
    [],
    ['', 'SECTION TOTALS'],
    ...sections.map((s) => ['', s.section, '', '', '', '', s.total]),
    ['', 'GRAND TOTAL', '', '', '', '', total],
  ];

  return rows.map((r) => r.map(csvEscape).join(',')).join('\n');
}

async function buildCostSummary(project, orgId) {
  const est = await computeEstimate(project.id, { regionName: 'Lagos', orgId });
  const rows = [
    ['BuildQ AI — Cost Summary'],
    ['Project', project.name, project.code],
    ['Region', est.region],
    ['Generated', new Date().toISOString()],
    [],
    ['Basis (BOQ total)', est.basis],
    [],
    ['Category', 'Amount'],
    ...Object.entries(est.categories).map(([k, v]) => [k, v]),
    ['Total', est.total],
    [],
    ['Benchmark', est.benchmark === null ? 'not set' : est.benchmark],
    ['Variance', est.variance === null ? 'n/a' : est.variance],
    [],
    ['Notes'],
    ...est.notes.map((n) => [n.type, n.text]),
  ];
  return rows.map((r) => r.map(csvEscape).join(',')).join('\n');
}

// GET /reports
export const list = asyncHandler(async (req, res) => {
  const rows = await prisma.buildqReport.findMany({
    where: { orgId: req.buildqUser.orgId },
    include: { project: true },
    orderBy: { generatedAt: 'desc' },
    take: 100,
  });

  res.json({
    reports: rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      format: r.format,
      project: r.project?.name ?? null,
      projectId: r.project?.code ?? null,
      generatedAt: r.generatedAt.toISOString(),
    })),
  });
});

// POST /reports/generate — produces a real file from real data.
export const generate = asyncHandler(async (req, res) => {
  const { projectId: projectKey, type = 'boq' } = req.body || {};

  const project = await prisma.buildqProject.findFirst({
    where: { orgId: req.buildqUser.orgId, OR: [{ code: projectKey }, { id: projectKey }] },
  });
  if (!project) throw BuildqError.notFound('That project does not exist.', 'project_not_found');

  let content;
  let name;
  if (type === 'boq') {
    content = await buildBoqReport(project);
    name = `${project.code} — Bill of Quantities`;
  } else if (type === 'cost-summary') {
    content = await buildCostSummary(project, req.buildqUser.orgId);
    name = `${project.code} — Cost Summary`;
  } else {
    throw BuildqError.badRequest(
      `Report type "${type}" is not available. Choose "boq" or "cost-summary".`,
      undefined,
      'unknown_report_type'
    );
  }

  const buffer = Buffer.from(content, 'utf8');
  const { storageKey, storageUrl } = await uploadDocument(
    { originalname: `${project.code}-${type}.csv`, buffer, mimetype: 'text/csv' },
    { orgId: req.buildqUser.orgId }
  );

  const report = await prisma.buildqReport.create({
    data: {
      orgId: req.buildqUser.orgId,
      projectId: project.id,
      name,
      type,
      format: 'csv',
      storageKey,
      storageUrl,
    },
  });

  await recordActivity({
    orgId: req.buildqUser.orgId,
    projectId: project.id,
    actorId: req.buildqUser.id,
    action: 'generated report',
    target: name,
    type: 'success',
  });

  res.status(201).json({
    report: {
      id: report.id,
      name: report.name,
      type: report.type,
      format: report.format,
      generatedAt: report.generatedAt.toISOString(),
    },
  });
});

// GET /reports/:reportId/download
export const download = asyncHandler(async (req, res) => {
  const report = await prisma.buildqReport.findFirst({
    where: { id: req.params.reportId, orgId: req.buildqUser.orgId },
  });
  if (!report) throw BuildqError.notFound('That report does not exist.', 'report_not_found');

  res.json({
    url: signedUrl(report.storageKey, { seconds: 300 }),
    expiresIn: 300,
    name: `${report.name}.${report.format}`,
  });
});

// ─── Analytics ───────────────────────────────────────────────────────────────
// The dashboard currently shows static figures: win rate 72%, avg margin 18.4%,
// estimate accuracy 98.2%. Two of those cannot be computed from anything in the
// schema — there is no tender outcome and no actual-cost feedback loop — so
// they are returned as null with a reason rather than as invented percentages.
export const kpis = asyncHandler(async (req, res) => {
  const orgId = req.buildqUser.orgId;

  const [projects, activeProjects, reports, revisions, boqAgg, docs, analyses] = await Promise.all([
    prisma.buildqProject.count({ where: { orgId } }),
    prisma.buildqProject.count({ where: { orgId, status: 'In Progress' } }),
    prisma.buildqReport.count({ where: { orgId } }),
    prisma.buildqBoqRevision.count({ where: { project: { orgId } } }),
    prisma.buildqProject.aggregate({ where: { orgId }, _sum: { budget: true, spent: true } }),
    prisma.buildqDocument.count({ where: { orgId } }),
    prisma.buildqAnalysisJob.count({ where: { document: { orgId }, status: 'succeeded' } }),
  ]);

  res.json({
    kpis: {
      projects,
      activeProjects,
      portfolioValue: Number(boqAgg._sum.budget || 0),
      spent: Number(boqAgg._sum.spent || 0),
      boqsGenerated: revisions,
      reportsGenerated: reports,
      documents: docs,
      drawingsAnalysed: analyses,
      // Not computable from the current schema.
      winRate: null,
      averageMargin: null,
      estimateAccuracy: null,
    },
    unavailable: {
      winRate: 'No tender outcomes are recorded. Add won/lost tracking to compute this.',
      averageMargin: 'No actual costs are recorded against estimates.',
      estimateAccuracy: 'Requires final account figures to compare estimates against.',
    },
  });
});

// GET /analytics/tenders
export const tenders = asyncHandler(async (_req, res) => {
  res.json({
    tenders: [],
    notes: [
      {
        type: 'info',
        text: 'Tender outcomes are not tracked yet, so there is nothing to chart. The static figures on this screen were placeholders.',
      },
    ],
  });
});

// ─── Notifications ───────────────────────────────────────────────────────────
export const notifications = asyncHandler(async (req, res) => {
  const rows = await prisma.buildqNotification.findMany({
    where: { orgId: req.buildqUser.orgId, OR: [{ userId: req.buildqUser.id }, { userId: null }] },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  res.json({
    notifications: rows.map((n) => ({
      id: n.id,
      title: n.title,
      detail: n.detail,
      type: n.type,
      link: n.link,
      read: Boolean(n.readAt),
      createdAt: n.createdAt.toISOString(),
    })),
    unread: rows.filter((n) => !n.readAt).length,
  });
});

export const markRead = asyncHandler(async (req, res) => {
  const { count } = await prisma.buildqNotification.updateMany({
    where: {
      id: req.params.notificationId,
      orgId: req.buildqUser.orgId,
      OR: [{ userId: req.buildqUser.id }, { userId: null }],
    },
    data: { readAt: new Date() },
  });
  if (!count) throw BuildqError.notFound('That notification does not exist.', 'notification_not_found');
  res.json({ ok: true });
});

export const markAllRead = asyncHandler(async (req, res) => {
  const { count } = await prisma.buildqNotification.updateMany({
    where: {
      orgId: req.buildqUser.orgId,
      OR: [{ userId: req.buildqUser.id }, { userId: null }],
      readAt: null,
    },
    data: { readAt: new Date() },
  });
  res.json({ ok: true, marked: count });
});
