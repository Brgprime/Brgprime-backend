import { prisma } from '../../../config/prisma.js';
import { buildqFeatures } from '../config.js';
import { analyseDocument, storeAnalysis } from './analysis.service.js';
import { sendAnalysisCompleteEmail } from './email.service.js';

// ─────────────────────────────────────────────────────────────────────────────
// Analysis job queue.
//
// §11 requires analysis to be async ("Analysis is slow: expose it as an async
// job, not a blocking request") and the spec's stack asks for REDIS_URL. Redis
// would be a new service, so the queue is a Postgres table and the worker runs
// in this process.
//
// The claim is atomic — updateMany filtered on status 'queued' — so if the
// service ever runs on more than one instance, two workers cannot take the
// same job. That is the only thing Redis was buying us here.
// ─────────────────────────────────────────────────────────────────────────────

const POLL_MS = Number(process.env.BUILDQ_QUEUE_POLL_MS || 5000);
const MAX_ATTEMPTS = 3;
// A stuck job (process died mid-run) is returned to the queue after this.
const STALE_MS = 10 * 60 * 1000;

let timer = null;
let running = false;

// Takes exactly one queued job, or returns null. The updateMany count tells us
// whether we won the race.
async function claimNext() {
  const candidate = await prisma.buildqAnalysisJob.findFirst({
    where: { status: 'queued', attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!candidate) return null;

  const { count } = await prisma.buildqAnalysisJob.updateMany({
    where: { id: candidate.id, status: 'queued' },
    data: { status: 'running', startedAt: new Date(), attempts: { increment: 1 } },
  });
  if (count === 0) return null; // another worker got there first

  return prisma.buildqAnalysisJob.findUnique({
    where: { id: candidate.id },
    include: { document: { include: { project: true, uploadedBy: true } } },
  });
}

// Returns jobs abandoned by a dead process to the queue.
async function requeueStale() {
  await prisma.buildqAnalysisJob.updateMany({
    where: {
      status: 'running',
      startedAt: { lt: new Date(Date.now() - STALE_MS) },
      attempts: { lt: MAX_ATTEMPTS },
    },
    data: { status: 'queued' },
  });
}

export async function runJob(job) {
  const { document } = job;
  try {
    const { result, usage, model } = await analyseDocument(document);
    await storeAnalysis(document, result);

    await prisma.buildqAnalysisJob.update({
      where: { id: job.id },
      data: {
        status: 'succeeded',
        finishedAt: new Date(),
        error: null,
        result: {
          ...result,
          model,
          usage: usage ? { input: usage.input_tokens, output: usage.output_tokens } : null,
        },
      },
    });

    await prisma.buildqNotification.create({
      data: {
        orgId: document.orgId,
        userId: document.uploadedById,
        title: `Analysis finished — ${document.name}`,
        detail: `${result.measurements.length} measurement(s) and ${result.elements.length} element(s) recorded.`,
        type: 'ai',
        link: '/app/takeoff',
      },
    });

    await prisma.buildqActivityEvent.create({
      data: {
        orgId: document.orgId,
        projectId: document.projectId,
        action: 'analysed',
        target: document.name,
        type: 'ai',
      },
    });

    if (document.uploadedBy?.email) {
      sendAnalysisCompleteEmail(document.uploadedBy.email, document.uploadedBy.name, {
        documentName: document.name,
        projectName: document.project?.name || 'your project',
      });
    }

    return { ok: true };
  } catch (err) {
    const message = err?.message || String(err);
    const exhausted = job.attempts >= MAX_ATTEMPTS;

    await prisma.buildqAnalysisJob.update({
      where: { id: job.id },
      data: {
        status: exhausted ? 'failed' : 'queued',
        finishedAt: exhausted ? new Date() : null,
        error: message.slice(0, 500),
      },
    });

    if (exhausted) {
      // The document is marked Failed, not Ready. A failed read must never
      // leave the UI implying the drawing was understood.
      await prisma.buildqDocument.update({
        where: { id: document.id },
        data: { status: 'Failed' },
      });
      console.error(`[buildq] analysis failed for ${document.name}: ${message}`);
    }

    return { ok: false, error: message };
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await requeueStale();
    // Drain up to a few jobs per tick so a backlog clears without hogging the
    // event loop of the shared BRG Prime process.
    for (let i = 0; i < 3; i += 1) {
      const job = await claimNext();
      if (!job) break;
      await runJob(job);
    }
  } catch (err) {
    console.error('[buildq] queue tick failed:', err?.message || err);
  } finally {
    running = false;
  }
}

export function startQueue() {
  if (timer) return { started: false, reason: 'already running' };
  if (!buildqFeatures.ai) {
    return { started: false, reason: 'ANTHROPIC_API_KEY not set — jobs will queue but not run' };
  }
  if (process.env.BUILDQ_QUEUE_DISABLED === 'true') {
    return { started: false, reason: 'disabled by BUILDQ_QUEUE_DISABLED' };
  }

  timer = setInterval(tick, POLL_MS);
  // Do not hold the process open on shutdown.
  if (typeof timer.unref === 'function') timer.unref();
  return { started: true, pollMs: POLL_MS };
}

export function stopQueue() {
  if (timer) clearInterval(timer);
  timer = null;
}

// Runs a specific job immediately, for the synchronous /analyze path.
export async function runJobNow(jobId) {
  const { count } = await prisma.buildqAnalysisJob.updateMany({
    where: { id: jobId, status: { in: ['queued', 'failed'] } },
    data: { status: 'running', startedAt: new Date(), attempts: { increment: 1 } },
  });
  if (count === 0) return { ok: false, error: 'Job is already running or finished.' };

  const job = await prisma.buildqAnalysisJob.findUnique({
    where: { id: jobId },
    include: { document: { include: { project: true, uploadedBy: true } } },
  });
  return runJob(job);
}
