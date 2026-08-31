import { prisma } from '../../../config/prisma.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { BuildqError } from '../lib/errors.js';
import { buildqEnv } from '../config.js';
import { chat, streamChat } from '../services/ai.service.js';
import { currentItems, totals } from '../services/boq.service.js';

// ─────────────────────────────────────────────────────────────────────────────
// The AI assistant.
//
// Replaces regex keyword matching against five canned paragraphs. The four
// intents those canned replies covered — reinforcement estimation, BOQ
// generation, cost-saving alternatives and market-rate comparison — are all
// answerable from the project's own data, so that data is what the model is
// given. It is not asked to recall Nigerian construction prices from training;
// it is handed the rate library and told to use it.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_HISTORY = 20;

function systemPrompt(context) {
  return `You are the BuildQ AI assistant, helping a quantity surveyor working on a construction project in Nigeria. You follow NIQS / RICS SMM7 measurement conventions and quote money in Naira.

GROUNDING — you have been given this project's actual bill of quantities, takeoff measurements, drawings and rate library below. Answer from that data.
  - When you state a quantity or a price that appears in the data, use the data's figure exactly.
  - When a figure is NOT in the data, say so plainly. Do not supply a market price from memory — rates vary by region and date, and a number you invent could end up in a tender.
  - Rates flagged as demo values are placeholders, not market prices. If you use one, say that it is a placeholder.

MEASUREMENT CONVENTIONS you must respect when advising:
  in-situ concrete m³ · formwork m² (billed separately) · reinforcement tonne · blockwork and finishes m² · excavation m³ · pipes and cables m · fittings no.
  Never describe concrete as measured in m². A slab yields concrete by volume AND formwork to the soffit by area.
  Reinforcement typically runs 100–130 kg per m³ of concrete for residential work; below 90 kg/m³ is worth questioning.

STYLE — you are talking to a professional. Be direct and brief. Use figures and short tables rather than prose where a figure will do. Do not pad with caveats, and do not restate the question.

${context}`;
}

// Assembles the project's real data. Kept compact — a bill can be long, and the
// useful signal is the section totals plus the largest lines.
async function buildContext(orgId, projectId) {
  if (!projectId) {
    const rates = await prisma.buildqRate.findMany({
      where: { OR: [{ orgId }, { orgId: null }] },
      orderBy: { name: 'asc' },
      take: 60,
    });
    return [
      'CONTEXT: no project selected. You have the rate library only.',
      '',
      'RATE LIBRARY:',
      ...rates.map((r) => `  ${r.name} — ₦${r.rateNaira.toLocaleString()} per ${r.unit} (${r.region})${r.isDemo ? ' [DEMO VALUE]' : ''}`),
    ].join('\n');
  }

  const project = await prisma.buildqProject.findFirst({ where: { id: projectId, orgId } });
  if (!project) return 'CONTEXT: the selected project could not be read.';

  const [{ revision, items }, measurements, documents, rates] = await Promise.all([
    currentItems(projectId),
    prisma.buildqMeasurement.findMany({
      where: { projectId },
      include: { document: true },
      take: 60,
    }),
    prisma.buildqDocument.findMany({ where: { projectId }, take: 40 }),
    prisma.buildqRate.findMany({
      where: { OR: [{ orgId }, { orgId: null }] },
      orderBy: { name: 'asc' },
      take: 60,
    }),
  ]);

  const { sections, total } = totals(items);
  const biggest = [...items]
    .sort((a, b) => b.qty * b.rate - a.qty * a.rate)
    .slice(0, 25);

  const lines = [
    `PROJECT: ${project.name} (${project.code})`,
    `  Client: ${project.client || 'not stated'} · Location: ${project.location || 'not stated'} · Type: ${project.type}`,
    `  Status: ${project.status} · Budget: ₦${Number(project.budget).toLocaleString()} · Spent: ₦${Number(project.spent).toLocaleString()}`,
    '',
    `DRAWINGS (${documents.length}):`,
    ...documents.map(
      (d) => `  ${d.name} — ${d.kind}, ${d.status}${d.detectedScale ? `, scale ${d.detectedScale}` : ''}`
    ),
    '',
  ];

  if (revision) {
    lines.push(
      `BILL OF QUANTITIES — revision ${revision.version}, source "${revision.source}", ${items.length} items, total ₦${total.toLocaleString()}`,
      ...sections.map((s) => `  ${s.section}: ₦${s.total.toLocaleString()}`),
      '',
      `LARGEST ITEMS:`,
      ...biggest.map(
        (i) =>
          `  ${i.code} ${i.description} — ${i.qty} ${i.unit} @ ₦${i.rate.toLocaleString()} = ₦${Math.round(i.qty * i.rate).toLocaleString()}${i.confidence === null ? ' [not measured]' : ` [confidence ${Math.round(i.confidence * 100)}%]`}`
      ),
      ''
    );
  } else {
    lines.push('BILL OF QUANTITIES: none generated for this project yet.', '');
  }

  lines.push(
    `TAKEOFF MEASUREMENTS (${measurements.length}):`,
    ...measurements.map(
      (m) =>
        `  ${m.name} — ${m.value} ${m.unit} (${m.auto ? 'detected' : 'entered by hand'}${m.confidence === null ? '' : `, confidence ${Math.round(m.confidence * 100)}%`})${m.document ? ` from ${m.document.name}` : ''}`
    ),
    '',
    `RATE LIBRARY:`,
    ...rates.map(
      (r) =>
        `  ${r.name} — ₦${r.rateNaira.toLocaleString()} per ${r.unit} (${r.region})${r.isDemo ? ' [DEMO VALUE]' : ''}`
    )
  );

  return lines.join('\n');
}

async function loadThread(orgId, userId, threadId, projectId) {
  if (threadId) {
    // A thread belongs to the person who opened it, not to the whole
    // organization — listThreads has always been scoped that way, and reading
    // a colleague's conversation by guessing its id should not be possible.
    const thread = await prisma.buildqAssistantThread.findFirst({
      where: { id: threadId, orgId, userId },
      // The MOST RECENT MAX_HISTORY messages, not the first ones. Taking them
      // ascending kept replaying the opening of a long conversation and
      // dropped everything the user had just said.
      include: { messages: { orderBy: { createdAt: 'desc' }, take: MAX_HISTORY } },
    });
    if (!thread) throw BuildqError.notFound('That conversation does not exist.', 'thread_not_found');
    return { ...thread, messages: [...thread.messages].reverse() };
  }
  const thread = await prisma.buildqAssistantThread.create({
    data: { orgId, userId, projectId: projectId || null },
  });
  return { ...thread, messages: [] };
}

// POST /assistant/chat
// Streams by default (spec §11: "real LLM, streaming preferred"). Send
// { stream: false } for a single JSON response.
export const chatWithAssistant = asyncHandler(async (req, res) => {
  const { message, threadId, projectId: projectKey, stream = true } = req.body || {};
  if (!message || !String(message).trim()) {
    throw BuildqError.badRequest('Type a message.', { message: 'Required.' });
  }

  let projectId = null;
  if (projectKey) {
    const project = await prisma.buildqProject.findFirst({
      where: { orgId: req.buildqUser.orgId, OR: [{ code: projectKey }, { id: projectKey }] },
      select: { id: true },
    });
    projectId = project?.id ?? null;
  }

  const thread = await loadThread(req.buildqUser.orgId, req.buildqUser.id, threadId, projectId);
  const context = await buildContext(req.buildqUser.orgId, projectId || thread.projectId);

  const history = (thread.messages || []).map((m) => ({ role: m.role, content: m.content }));
  const messages = [...history, { role: 'user', content: String(message) }];

  await prisma.buildqAssistantMessage.create({
    data: { threadId: thread.id, role: 'user', content: String(message) },
  });

  // Touch the thread on every turn: @updatedAt only fires on an update to the
  // thread row itself, so without this a busy conversation kept the timestamp
  // of its first message and sank to the bottom of the list.
  await prisma.buildqAssistantThread.update({
    where: { id: thread.id },
    data: {
      // Name the conversation from its first message.
      ...(history.length ? {} : { title: String(message).slice(0, 80) }),
      updatedAt: new Date(),
    },
  });

  const system = systemPrompt(context);

  if (!stream) {
    const { text, usage, model } = await chat({ system, messages });
    await prisma.buildqAssistantMessage.create({
      data: {
        threadId: thread.id,
        role: 'assistant',
        content: text,
        inputTokens: usage?.input_tokens ?? null,
        outputTokens: usage?.output_tokens ?? null,
        model,
      },
    });
    return res.json({ threadId: thread.id, reply: text });
  }

  // Server-sent events. `no-transform` keeps the shared compression middleware
  // from buffering the stream — without it the client sees nothing until the
  // response ends, which defeats the point.
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  send({ type: 'start', threadId: thread.id });

  let full = '';
  try {
    for await (const event of streamChat({ system, messages })) {
      if (event.type === 'delta') {
        full += event.text;
        send({ type: 'delta', text: event.text });
      } else if (event.type === 'error') {
        send({ type: 'error', message: event.message });
      } else if (event.type === 'done') {
        full = event.text || full;
        await prisma.buildqAssistantMessage.create({
          data: {
            threadId: thread.id,
            role: 'assistant',
            content: full,
            inputTokens: event.usage?.input_tokens ?? null,
            outputTokens: event.usage?.output_tokens ?? null,
            model: event.model,
          },
        });
        send({ type: 'done', threadId: thread.id });
      }
    }
  } catch (err) {
    // The response has already begun, so an error is delivered in-band.
    send({ type: 'error', message: err?.message || 'The assistant stopped unexpectedly.' });
  } finally {
    res.end();
  }
});

// GET /assistant/threads
export const listThreads = asyncHandler(async (req, res) => {
  const threads = await prisma.buildqAssistantThread.findMany({
    where: { orgId: req.buildqUser.orgId, userId: req.buildqUser.id },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    include: { _count: { select: { messages: true } } },
  });
  res.json({
    threads: threads.map((t) => ({
      id: t.id,
      title: t.title,
      projectId: t.projectId,
      messages: t._count.messages,
      updatedAt: t.updatedAt.toISOString(),
    })),
  });
});

// GET /assistant/threads/:threadId
export const getThread = asyncHandler(async (req, res) => {
  const thread = await prisma.buildqAssistantThread.findFirst({
    where: { id: req.params.threadId, orgId: req.buildqUser.orgId, userId: req.buildqUser.id },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!thread) throw BuildqError.notFound('That conversation does not exist.', 'thread_not_found');

  res.json({
    id: thread.id,
    title: thread.title,
    projectId: thread.projectId,
    messages: thread.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
    })),
  });
});

// DELETE /assistant/threads/:threadId
export const deleteThread = asyncHandler(async (req, res) => {
  const thread = await prisma.buildqAssistantThread.findFirst({
    where: { id: req.params.threadId, orgId: req.buildqUser.orgId, userId: req.buildqUser.id },
  });
  if (!thread) throw BuildqError.notFound('That conversation does not exist.', 'thread_not_found');
  await prisma.buildqAssistantThread.delete({ where: { id: thread.id } });
  res.json({ ok: true });
});

// GET /assistant/status — lets the UI say honestly whether AI is available.
export const status = asyncHandler(async (_req, res) => {
  res.json({
    available: Boolean(buildqEnv.anthropicApiKey),
    model: buildqEnv.anthropicApiKey ? buildqEnv.model : null,
  });
});
