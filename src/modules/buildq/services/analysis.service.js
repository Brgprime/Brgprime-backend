import { z } from 'zod';

import { prisma } from '../../../config/prisma.js';
import { extract, pdfBlock, imageBlock, assertFits } from './ai.service.js';
import { fetchBuffer, signedUrl } from './storage.service.js';
import { normalizeUnit, violatesConvention, expectedUnitFor } from '../lib/units.js';
import { unitForType, TYPE_COLOR } from '../lib/serializers.js';
import { SECTION_ORDER } from '../lib/codes.js';

// ─────────────────────────────────────────────────────────────────────────────
// The analysis engine.
//
// What it replaces: a stand-in that derived every figure from the FILE NAME and
// SIZE. The same drawing named three ways produced three different bills
// (₦54.1M / ₦27.8M / ₦8.5M), and an empty PDF named "Foundation Layout.pdf"
// produced a full substructure bill.
//
// What it does instead: reads the actual file. And — the part that matters —
// it distinguishes what it READ from what it INFERRED:
//
//   read     a dimension string, schedule row or annotated area on the drawing
//   counted  symbols counted on the sheet (doors, windows, columns)
//   derived  computed from an assumption (e.g. slab volume = area × thickness)
//
// Only `read` and `counted` figures carry a confidence. Anything `derived`
// has its confidence stripped, because §12 is explicit: "Omit confidence
// rather than inventing one." A confidence score on a number nothing measured
// is a lie, and it is the exact lie the old stand-in told.
// ─────────────────────────────────────────────────────────────────────────────

const Basis = z.enum(['read', 'counted', 'derived']);

const AnalysisSchema = z.object({
  sheetType: z.enum(['plan', 'section', 'elevation', 'detail', 'schedule', 'mixed', 'unknown']),
  discipline: z.enum(['architectural', 'structural', 'services', 'civil', 'unknown']),
  scale: z.string().nullable(),
  scaleBasis: z.enum(['scale_bar', 'title_block', 'dimension_string', 'none']),
  pages: z.number().int().min(0),
  elements: z.array(
    z.object({
      type: z.string(),
      count: z.number().nullable(),
      length: z.number().nullable(),
      area: z.number().nullable(),
      volume: z.number().nullable(),
      unit: z.string().nullable(),
      basis: Basis,
      confidence: z.number().min(0).max(1).nullable(),
    })
  ),
  measurements: z.array(
    z.object({
      name: z.string(),
      type: z.enum(['Linear', 'Area', 'Volume', 'Count']),
      value: z.number(),
      unit: z.string(),
      basis: Basis,
      confidence: z.number().min(0).max(1).nullable(),
      note: z.string().nullable(),
    })
  ),
  warnings: z.array(z.string()),
});

const ANALYSIS_SYSTEM = `You are a quantity surveyor reading construction drawings for the Nigerian market (NIQS / RICS SMM7 conventions).

Your job is to report what is ACTUALLY ON THE SHEET. You are not estimating a building; you are reading a document.

BASIS — the most important field. For every figure, state how you obtained it:
  "read"     — you read a dimension string, a schedule row, an annotated area, or a stated quantity directly off the drawing.
  "counted"  — you counted symbols or instances on the sheet.
  "derived"  — you computed it from an assumption (a standard thickness, a typical storey height, a conversion factor).

Never label something "read" that you inferred. If a slab area is annotated but its thickness is not, the area is "read" and any volume you compute from an assumed thickness is "derived".

CONFIDENCE — a number from 0 to 1, or null.
  Give a confidence ONLY for "read" and "counted" figures, reflecting how legible the source was.
  For "derived" figures set confidence to null. Do not estimate a confidence for a number you did not measure.

UNITS — return these exact strings and no others:
  m, mm, km, m², m³, no, pair, set, kg, tonne, L, hr, day, week, month, item, sum
  Measurement conventions you must follow:
    in-situ concrete (slabs, beams, columns, footings, blinding)  m³  — ALWAYS volume, never area
    formwork                                                       m²  — billed SEPARATELY from the concrete
    reinforcement                                                  tonne
    blockwork, walling, plaster, render, paint, tiling, screed     m²
    excavation, filling, hardcore                                  m³
    site clearance, topsoil removal                                m²
    pipes, cables, fascia, skirting                                m
    doors, sanitary fittings, sockets, light fittings              no
  A slab measured off a plan yields TWO things: an area (m²), and — only if a thickness is stated or assumed — a volume (m³). Never report a concrete quantity in m².

SCALE — report the drawing scale only if you can see it (a scale bar, the title block, or a dimension string you can reason from). Otherwise scale is null and scaleBasis is "none".

WARNINGS — say plainly what you could not do: unreadable scale bar, missing dimensions, a sheet that is not a drawing, a schedule you could only partly read. An empty or unreadable sheet must produce empty elements and measurements plus a warning, NOT invented figures.

If the document contains no construction drawing at all, return empty arrays and say so in warnings. Never fabricate quantities to fill the response.`;

// ─── DXF ─────────────────────────────────────────────────────────────────────
// DXF is a plain-text pairs format, so it can be summarised in-process without
// a CAD library. Layer names and annotation text are genuinely informative —
// a layer called "S-COLS" and text reading "225x225" say a great deal.
export function summariseDxf(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim());
  const entities = new Map();
  const layers = new Set();
  const texts = [];
  let insUnits = null;

  for (let i = 0; i < lines.length - 1; i += 1) {
    const code = lines[i];
    const value = lines[i + 1];

    if (code === '0' && /^[A-Z][A-Z0-9_]*$/.test(value)) {
      entities.set(value, (entities.get(value) || 0) + 1);
    }
    if (code === '8' && value) layers.add(value);
    if ((code === '1' || code === '3') && value && value.length > 1 && texts.length < 400) {
      texts.push(value);
    }
    if (value === '$INSUNITS') insUnits = lines[i + 3] ?? null;
  }

  const topEntities = [...entities.entries()]
    .filter(([k]) => !['SECTION', 'ENDSEC', 'TABLE', 'ENDTAB', 'EOF', 'CLASS'].includes(k))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25);

  return [
    `DXF drawing summary (extracted in-process; no CAD renderer was used).`,
    insUnits ? `Header $INSUNITS: ${insUnits}` : `Header $INSUNITS: not stated`,
    ``,
    `Layers (${layers.size}): ${[...layers].slice(0, 60).join(', ')}`,
    ``,
    `Entity counts: ${topEntities.map(([k, v]) => `${k}=${v}`).join(', ')}`,
    ``,
    `Annotation text found on the drawing (${texts.length} strings):`,
    texts.slice(0, 400).join(' | '),
  ].join('\n');
}

// ─── Post-processing ─────────────────────────────────────────────────────────
// The model's output is checked against §9 before anything is stored. This is
// the guard that stops a unit error becoming a bill wrong by a factor of 6.7.
export function sanitise(result) {
  const warnings = [...(result.warnings || [])];

  const measurements = (result.measurements || []).map((m) => {
    const unit = normalizeUnit(m.unit) || unitForType(m.type);

    // §12: omit confidence rather than inventing one.
    let confidence = m.basis === 'derived' ? null : m.confidence;
    if (confidence !== null && (confidence < 0 || confidence > 1)) confidence = null;

    const clash = violatesConvention(m.name, unit);
    if (clash) {
      warnings.push(
        `"${m.name}" was returned in ${clash.actual} but is billed in ${clash.expected}; it has been flagged rather than used.`
      );
    }

    return { ...m, unit, confidence, conventionClash: Boolean(clash) };
  });

  const elements = (result.elements || []).map((e) => ({
    ...e,
    unit: e.unit ? normalizeUnit(e.unit) : null,
    confidence: e.basis === 'derived' ? null : e.confidence,
  }));

  if (!measurements.length && !elements.length) {
    warnings.push('Nothing measurable was found on this document.');
  }

  return { ...result, elements, measurements, warnings };
}

// ─── Running an analysis ─────────────────────────────────────────────────────
export async function analyseDocument(document) {
  // Read it back through a freshly signed URL, not the stored secure_url:
  // documents are held under authenticated delivery, so the bare URL 401s.
  const buffer = await fetchBuffer(signedUrl(document.storageKey, { seconds: 300 }));
  assertFits(buffer, document.name);

  const content = [];

  if (document.ext === 'pdf') {
    content.push(pdfBlock(buffer));
  } else if (['png', 'jpg', 'jpeg'].includes(document.ext)) {
    const mediaType = document.ext === 'png' ? 'image/png' : 'image/jpeg';
    content.push(imageBlock(buffer, mediaType));
  } else if (document.ext === 'dxf') {
    content.push({ type: 'text', text: summariseDxf(buffer.toString('utf8')) });
  } else {
    // Should be unreachable — upload marks these un-analysable — but an engine
    // that guesses when it does not recognise a format is the original bug.
    throw new Error(`No reader for .${document.ext} files.`);
  }

  content.push({
    type: 'text',
    text: `This document is named "${document.name}". Ignore the file name entirely when deciding what is on the sheet — read the drawing itself. Report what you can actually see.`,
  });

  const { data, usage, model } = await extract({
    system: ANALYSIS_SYSTEM,
    content,
    schema: AnalysisSchema,
    effort: 'high',
    maxTokens: 16000,
  });

  return { result: sanitise(data), usage, model };
}

// Persists an analysis result against its document.
export async function storeAnalysis(document, result) {
  await prisma.$transaction(async (tx) => {
    await tx.buildqDetectedElement.deleteMany({ where: { documentId: document.id } });
    await tx.buildqMeasurement.deleteMany({ where: { documentId: document.id, auto: true } });

    if (result.elements.length) {
      await tx.buildqDetectedElement.createMany({
        data: result.elements.map((e) => ({
          documentId: document.id,
          type: e.type,
          count: e.count ?? null,
          length: e.length ?? null,
          area: e.area ?? null,
          volume: e.volume ?? null,
          unit: e.unit ?? null,
          confidence: e.confidence ?? null,
          geometry: { basis: e.basis },
        })),
      });
    }

    // A measurement that breaks a §9 convention is not written to the takeoff —
    // it would flow straight into a bill. It stays in the warnings instead.
    const usable = result.measurements.filter((m) => !m.conventionClash && document.projectId);
    if (usable.length) {
      await tx.buildqMeasurement.createMany({
        data: usable.map((m) => ({
          documentId: document.id,
          projectId: document.projectId,
          name: m.name,
          type: m.type,
          value: m.value,
          unit: m.unit,
          color: TYPE_COLOR[m.type] || '#1CA5F6',
          auto: true,
          confidence: m.confidence,
        })),
      });
    }

    await tx.buildqDocument.update({
      where: { id: document.id },
      data: {
        status: 'Ready',
        pageCount: result.pages || null,
        detectedScale: result.scale || null,
      },
    });
  });
}

// ─── BOQ generation ──────────────────────────────────────────────────────────
// Claude decides WHAT work items follow from the measured quantities — that is
// surveying judgement. It never decides what anything COSTS: rates come from
// the rate library, matched after the fact. Letting the model invent prices
// would put made-up naira figures into a tender document.

const BoqSchema = z.object({
  items: z.array(
    z.object({
      description: z.string(),
      section: z.enum([
        'Substructure',
        'Superstructure',
        'Roofing',
        'Finishes',
        'Doors & Windows',
        'Services',
        'External Works',
      ]),
      unit: z.string(),
      qty: z.number(),
      basis: Basis,
      confidence: z.number().min(0).max(1).nullable(),
      rateKey: z.string().nullable(),
      sources: z.array(z.string()),
    })
  ),
  notes: z.array(z.object({ type: z.enum(['success', 'info', 'warning']), text: z.string() })),
});

function boqSystem(rateNames) {
  return `You are a quantity surveyor preparing a Bill of Quantities to NIQS convention from measured quantities taken off drawings.

You will be given measurements and detected elements, each labelled with how it was obtained ("read", "counted" or "derived").

Produce BOQ line items. Rules:

SECTIONS — use exactly one of: Substructure, Superstructure, Roofing, Finishes, Doors & Windows, Services, External Works.

UNITS AND CONVENTIONS — this is the part that must not be wrong:
  in-situ concrete       m³    formwork    m²  (a SEPARATE item from the concrete)
  reinforcement          tonne
  blockwork, finishes    m²    excavation  m³
  pipes, cables          m     fittings    no
  A slab produces at least two items: the concrete by volume, and the formwork to its soffit by area. Never bill concrete in m².

BASIS AND CONFIDENCE — carry through from the input. An item computed from a "derived" quantity is itself "derived" and MUST have confidence null. Only pass a confidence through for items resting on read or counted figures.

ASSUMPTIONS — where you apply a standard dimension because the drawing did not state one, say so in the description, e.g. "Reinforced concrete strip footing (600 x 225mm assumed)". Never hide an assumption.

RATEKEY — set this to the closest matching name from the rate library below, copied EXACTLY. If nothing matches, set it to null. Do NOT invent a price; you are not being asked for one and any figure you supply will be discarded.

SOURCES — list the drawing file names each item was derived from. Never leave this empty.

NOTES — flag what is missing: a discipline with no drawing supplied, a quantity you could not derive, an assumption a surveyor should check.

Rate library (names you may use for rateKey):
${rateNames.map((n) => `  - ${n}`).join('\n')}`;
}

export async function generateBoq({ documents, measurements, elements, orgId, region = 'Lagos' }) {
  const rates = await prisma.buildqRate.findMany({
    where: { region, OR: [{ orgId }, { orgId: null }] },
    orderBy: { orgId: 'desc' },
  });

  const rateByName = new Map();
  for (const r of rates) {
    if (!rateByName.has(r.name)) rateByName.set(r.name, r);
  }

  const payload = {
    drawings: documents.map((d) => ({ name: d.name, kind: d.kind, scale: d.detectedScale })),
    measurements: measurements.map((m) => ({
      name: m.name,
      type: m.type,
      value: m.value,
      unit: m.unit,
      basis: m.auto ? 'read' : 'entered',
      confidence: m.confidence,
      source: m.document?.name ?? null,
    })),
    elements: elements.map((e) => ({
      type: e.type,
      count: e.count,
      length: e.length,
      area: e.area,
      volume: e.volume,
      unit: e.unit,
      basis: e.geometry?.basis ?? 'derived',
    })),
  };

  const { data, usage, model } = await extract({
    system: boqSystem([...rateByName.keys()]),
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    schema: BoqSchema,
    effort: 'high',
    maxTokens: 16000,
  });

  const notes = [...(data.notes || [])];
  const items = [];

  for (const item of data.items || []) {
    const unit = normalizeUnit(item.unit);

    // Last line of defence: the model was told the conventions, but a bill is
    // not the place to find out it slipped.
    const clash = violatesConvention(item.description, unit);
    if (clash) {
      notes.push({
        type: 'warning',
        text: `Dropped "${item.description}" — returned in ${clash.actual} but must be billed in ${clash.expected}.`,
      });
      continue;
    }

    const rate = item.rateKey ? rateByName.get(item.rateKey) : null;
    if (item.rateKey && !rate) {
      notes.push({
        type: 'info',
        text: `No library rate named "${item.rateKey}"; "${item.description}" is unpriced.`,
      });
    }
    if (rate && rate.unit !== unit) {
      notes.push({
        type: 'warning',
        text: `"${item.description}" is measured in ${unit} but the rate "${rate.name}" is per ${rate.unit}; left unpriced.`,
      });
    }

    items.push({
      description: item.description,
      section: SECTION_ORDER.includes(item.section) ? item.section : 'Superstructure',
      unit,
      qty: item.qty,
      // The price comes from the database, never from the model.
      rate: rate && rate.unit === unit ? rate.rateNaira : 0,
      confidence: item.basis === 'derived' ? null : item.confidence,
      sources: item.sources?.length ? item.sources : documents.map((d) => d.name),
    });
  }

  const unpriced = items.filter((i) => !i.rate).length;
  if (unpriced) {
    notes.push({
      type: 'warning',
      text: `${unpriced} item(s) have no rate and are priced at zero. Add them to your rate library.`,
    });
  }
  if (rates.some((r) => r.isDemo)) {
    notes.push({
      type: 'warning',
      text: 'Some rates used are demo seed values, not market prices. Replace them before issuing this bill.',
    });
  }

  return { items, notes, usage, model };
}
