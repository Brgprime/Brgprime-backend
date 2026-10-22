import { prisma } from '../../../config/prisma.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { BuildqError } from '../lib/errors.js';
import { serializeDocument, serializeMeasurement } from '../lib/serializers.js';
import { recordActivity } from '../middleware/scope.js';
import { generateBoq, quantifyItem } from '../services/analysis.service.js';
import { runJobNow, readableError } from '../services/queue.service.js';
import { createRevision, currentItems } from '../services/boq.service.js';
import {
  uploadDocument,
  extensionOf,
  kindOf,
  isDrawing,
  isAnalysable,
} from '../services/storage.service.js';

// ─────────────────────────────────────────────────────────────────────────────
// The two endpoints from §12 that the frontend's services/analysis.js calls,
// plus the async equivalents used inside the app.
//
// Note the confidence scales, which the spec defines twice and differently:
//   §12 (this engine contract)  0–1, omitted when not measured
//   §6  (the app's BOQ item)    0–100, or null
// These endpoints speak §12. /projects/:id/boq speaks §6. The database stores
// 0–1 and the serializer converts, so the two never disagree.
// ─────────────────────────────────────────────────────────────────────────────

// Shapes an analysis job result into exactly the §12 /analyze response.
function engineShape(document, result) {
  return {
    documentId: document.id,
    scale: result?.scale ?? null,
    pages: result?.pages ?? document.pageCount ?? 0,
    elements: (result?.elements || []).map((e) => ({
      type: e.type,
      ...(e.count !== null && e.count !== undefined ? { count: e.count } : {}),
      ...(e.length !== null && e.length !== undefined ? { length: e.length } : {}),
      ...(e.area !== null && e.area !== undefined ? { area: e.area } : {}),
      ...(e.volume !== null && e.volume !== undefined ? { volume: e.volume } : {}),
      ...(e.unit ? { unit: e.unit } : {}),
    })),
    measurements: (result?.measurements || [])
      .filter((m) => !m.conventionClash)
      .map((m) => ({
        name: m.name,
        type: m.type,
        value: m.value,
        unit: m.unit,
        // Omitted entirely, not null, when nothing measured it.
        ...(m.confidence === null || m.confidence === undefined ? {} : { confidence: m.confidence }),
      })),
    warnings: result?.warnings || [],
  };
}

// POST /analyze — the frontend's seam. Uploads, analyses and answers in one
// call, because services/analysis.js expects the result directly. The async
// path (upload → job → poll) is what the app itself uses.
export const analyze = asyncHandler(async (req, res) => {
  if (!req.file) throw BuildqError.badRequest('Attach a drawing.', { file: 'Required.' });

  const projectKey = req.body?.projectId;
  if (!projectKey) throw BuildqError.badRequest('projectId is required.', { projectId: 'Required.' });

  const project = await prisma.buildqProject.findFirst({
    where: { orgId: req.buildqUser.orgId, OR: [{ code: projectKey }, { id: projectKey }] },
  });
  if (!project) throw BuildqError.notFound('That project does not exist.', 'project_not_found');

  const ext = extensionOf(req.file.originalname);
  const kind = kindOf(ext);

  if (!isDrawing(kind) || !isAnalysable(ext)) {
    throw BuildqError.badRequest(
      `.${ext} files cannot be read by the analysis engine. PDF, PNG, JPG and DXF are supported; DWG, RVT and IFC need a converter this service does not run.`,
      undefined,
      'unsupported_for_analysis'
    );
  }

  const { storageKey, storageUrl, bytes } = await uploadDocument(req.file, {
    orgId: req.buildqUser.orgId,
  });

  const document = await prisma.buildqDocument.create({
    data: {
      orgId: req.buildqUser.orgId,
      projectId: project.id,
      name: req.file.originalname,
      ext,
      kind,
      sizeBytes: bytes ?? req.file.size ?? 0,
      mime: req.file.mimetype || '',
      storageKey,
      storageUrl,
      uploadedById: req.buildqUser.id,
      status: 'Analyzing',
    },
  });

  const job = await prisma.buildqAnalysisJob.create({
    data: { documentId: document.id, status: 'queued' },
  });

  const outcome = await runJobNow(job.id);
  if (!outcome.ok) {
    throw BuildqError.unavailable(
      `The drawing could not be analysed: ${outcome.error}`,
      'analysis_failed'
    );
  }

  const finished = await prisma.buildqAnalysisJob.findUnique({ where: { id: job.id } });
  const fresh = await prisma.buildqDocument.findUnique({ where: { id: document.id } });

  res.json(engineShape(fresh, finished.result));
});

// GET /analyze/:jobId
export const jobStatus = asyncHandler(async (req, res) => {
  const job = await prisma.buildqAnalysisJob.findFirst({
    where: { id: req.params.jobId, document: { orgId: req.buildqUser.orgId } },
    include: { document: true },
  });
  if (!job) throw BuildqError.notFound('That analysis job does not exist.', 'job_not_found');

  res.json({
    id: job.id,
    status: job.status,
    attempts: job.attempts,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    document: serializeDocument(job.document),
    ...(job.status === 'succeeded' ? engineShape(job.document, job.result) : {}),
  });
});

// POST /documents/:documentId/detect — takeoff "Auto-detect all".
export const detect = asyncHandler(async (req, res) => {
  const document = req.document;

  if (!isDrawing(document.kind) || !isAnalysable(document.ext)) {
    throw BuildqError.badRequest(
      `.${document.ext} files cannot be read by the analysis engine.`,
      undefined,
      'unsupported_for_analysis'
    );
  }

  const job = await prisma.buildqAnalysisJob.create({
    data: { documentId: document.id, status: 'queued' },
  });
  await prisma.buildqDocument.update({
    where: { id: document.id },
    data: { status: 'Analyzing' },
  });

  const outcome = await runJobNow(job.id);
  if (!outcome.ok) {
    throw BuildqError.unavailable(`Detection failed: ${outcome.error}`, 'analysis_failed');
  }

  const measurements = await prisma.buildqMeasurement.findMany({
    where: { documentId: document.id },
    include: { document: true },
    orderBy: { createdAt: 'asc' },
  });
  const finished = await prisma.buildqAnalysisJob.findUnique({ where: { id: job.id } });

  res.json({
    jobId: job.id,
    measurements: measurements.map(serializeMeasurement),
    warnings: finished.result?.warnings || [],
    scale: finished.result?.scale ?? null,
  });
});

// Gathers everything measured for a set of documents.
async function gather(orgId, projectId, documentIds) {
  const documents = await prisma.buildqDocument.findMany({
    where: {
      orgId,
      projectId,
      ...(documentIds?.length ? { id: { in: documentIds } } : {}),
    },
  });
  if (!documents.length) {
    throw BuildqError.badRequest(
      'No drawings were found for this project.',
      undefined,
      'no_documents'
    );
  }

  const ids = documents.map((d) => d.id);
  const [measurements, elements] = await Promise.all([
    prisma.buildqMeasurement.findMany({
      where: { documentId: { in: ids } },
      include: { document: true },
    }),
    prisma.buildqDetectedElement.findMany({ where: { documentId: { in: ids } } }),
  ]);

  return { documents, measurements, elements };
}

// POST /boq — the §12 engine contract: documents in, priced lines out.
export const boqFromDocuments = asyncHandler(async (req, res) => {
  const { projectId: projectKey, documentIds, region = 'Lagos' } = req.body || {};

  const project = await prisma.buildqProject.findFirst({
    where: { orgId: req.buildqUser.orgId, OR: [{ code: projectKey }, { id: projectKey }] },
  });
  if (!project) throw BuildqError.notFound('That project does not exist.', 'project_not_found');

  const { documents, measurements, elements } = await gather(
    req.buildqUser.orgId,
    project.id,
    documentIds
  );

  if (!measurements.length && !elements.length) {
    return res.json({
      items: [],
      notes: [
        {
          type: 'warning',
          text: 'None of the selected drawings have been analysed yet, so there is nothing to bill from.',
        },
      ],
    });
  }

  const { items, notes } = await generateBoq({
    documents,
    measurements,
    elements,
    orgId: req.buildqUser.orgId,
    region,
  });

  // §12 shape: 0–1 confidence, omitted when absent.
  res.json({
    items: items.map((i) => ({
      desc: i.description,
      section: i.section,
      unit: i.unit,
      qty: i.qty,
      rate: i.rate,
      ...(i.confidence === null || i.confidence === undefined ? {} : { confidence: i.confidence }),
      sources: i.sources,
    })),
    notes,
  });
});

// ─── BOQ generation runs ─────────────────────────────────────────────────────
// Generating a bill is one long model call. The app reaches this server through
// a Netlify proxy that gives up after ~26 seconds, and a bill routinely takes
// longer — so the request used to come back as a bare 504 while the server
// carried on and, as often as not, finished. The POST now answers at once with
// a run, the work continues here, and the client polls the run.

// A run still 'running' after this was lost with the process that held it
// (a deploy, or Render recycling the instance). Report it, don't wait on it.
const RUN_STALE_MS = 10 * 60 * 1000;

function isStale(run) {
  return run.status === 'running' && Date.now() - run.startedAt.getTime() > RUN_STALE_MS;
}

function serializeRun(run) {
  const stale = isStale(run);
  return {
    id: run.id,
    status: stale ? 'failed' : run.status,
    error: stale
      ? 'Generation was interrupted before it finished. Nothing was billed from it — generate again.'
      : run.error,
    revisionId: run.revisionId,
    generated: run.generated,
    notes: run.result?.notes ?? [],
    // What the prices are and when they were surveyed, so the screen can say
    // "Lagos rates as at 1 Sep 2026" instead of showing a timeless total.
    rates: run.result?.rates ?? null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

async function runGeneration(run, { project, user, documents, measurements, elements, region, standard, replace }) {
  try {
    const { items, notes, rates } = await generateBoq({
      documents,
      measurements,
      elements,
      orgId: user.orgId,
      region,
    });

    if (!items.length) {
      throw BuildqError.unavailable(
        'The engine could not produce any billable items from these drawings.',
        'no_items_generated'
      );
    }

    const existing = replace ? { items: [] } : await currentItems(project.id);
    const revision = await createRevision(project.id, [...existing.items, ...items], {
      source: 'engine',
      standard,
      region,
      createdById: user.id,
      generatedFrom: documents.map((d) => d.id),
      notes,
    });

    await prisma.buildqBoqGeneration.update({
      where: { id: run.id },
      data: {
        status: 'succeeded',
        finishedAt: new Date(),
        revisionId: revision.id,
        generated: items.length,
        result: { notes, rates: rates ?? null },
      },
    });

    await recordActivity({
      orgId: user.orgId,
      projectId: project.id,
      action: 'generated BOQ from',
      target: documents.map((d) => d.name).join(', ').slice(0, 120),
      type: 'ai',
    });
  } catch (err) {
    const message = readableError(err);
    console.error(`[buildq] BOQ generation failed for ${project.id}: ${message}`);
    await prisma.buildqBoqGeneration
      .update({
        where: { id: run.id },
        data: { status: 'failed', finishedAt: new Date(), error: message.slice(0, 500) },
      })
      .catch((e) => console.error('[buildq] could not record failed generation:', e?.message || e));
  }
}

// POST /projects/:projectId/boq/generate — same engine as POST /boq, but the
// result is stored as a new revision so the bill has a history. Answers 202
// with the run; GET .../boq/generations/:runId reports how it ended.
export const generateForProject = asyncHandler(async (req, res) => {
  const { documentIds, region = 'Lagos', standard = 'NIQS', replace = true } = req.body || {};

  // A run already under way for this project is returned rather than doubled:
  // a second click, or a client retrying, must not pay for the bill twice.
  const inFlight = await prisma.buildqBoqGeneration.findFirst({
    where: { projectId: req.project.id, status: 'running' },
    orderBy: { startedAt: 'desc' },
  });
  if (inFlight && !isStale(inFlight)) {
    return res.status(202).json({ generation: serializeRun(inFlight) });
  }

  // The cheap checks stay synchronous, so a request that can never succeed is
  // refused with its real reason instead of becoming a run that fails later.
  const { documents, measurements, elements } = await gather(
    req.buildqUser.orgId,
    req.project.id,
    documentIds
  );

  if (!measurements.length && !elements.length) {
    throw BuildqError.badRequest(
      'None of these drawings have been analysed yet. Run analysis first.',
      undefined,
      'nothing_analysed'
    );
  }

  const run = await prisma.buildqBoqGeneration.create({
    data: { projectId: req.project.id },
  });

  // Deliberately not awaited: the response goes now, the bill lands later.
  // runGeneration records its own failure, so nothing escapes unhandled.
  runGeneration(run, {
    project: req.project,
    user: req.buildqUser,
    documents,
    measurements,
    elements,
    region,
    standard,
    replace,
  });

  res.status(202).json({ generation: serializeRun(run) });
});

// GET /projects/:projectId/boq/generations/:runId
export const generationStatus = asyncHandler(async (req, res) => {
  const run = await prisma.buildqBoqGeneration.findFirst({
    where: { id: req.params.runId, projectId: req.project.id },
  });
  if (!run) throw BuildqError.notFound('That generation run does not exist.', 'generation_not_found');

  res.json({ generation: serializeRun(run) });
});

// POST /projects/:projectId/boq/items/quantify
//
// Measure one described item off the drawings already analysed for this
// project. Returns a proposal and stores nothing: the client shows the figure
// and its workings, and only a surveyor who accepts it turns it into a bill
// line through /boq/items. Adding a line by hand should not mean measuring it
// by hand, but neither should a sentence write itself into a bill.
export const quantifyForProject = asyncHandler(async (req, res) => {
  const { desc, section = null, unit = null, documentIds, region = 'Lagos' } = req.body || {};

  const { documents, measurements, elements } = await gather(
    req.buildqUser.orgId,
    req.project.id,
    documentIds
  );

  if (!measurements.length && !elements.length) {
    throw BuildqError.badRequest(
      'None of this project\u2019s drawings have been analysed yet, so there is nothing to measure against. Run analysis first, or enter the quantity by hand.',
      undefined,
      'nothing_analysed'
    );
  }

  const proposal = await quantifyItem({
    description: desc,
    section,
    unit,
    documents,
    measurements,
    elements,
    orgId: req.buildqUser.orgId,
    region,
  });

  await recordActivity({
    orgId: req.buildqUser.orgId,
    projectId: req.project.id,
    actorId: req.buildqUser.id,
    action: proposal.matched ? 'measured a described item' : 'could not measure a described item',
    target: desc.slice(0, 120),
    type: 'ai',
  });

  // 200 either way: "the drawings do not show that" is a real answer, not a
  // failure, and the form needs to fall back to manual entry rather than show
  // an error the surveyor has to dismiss.
  const { usage, model, ...body } = proposal;
  res.json(body);
});
