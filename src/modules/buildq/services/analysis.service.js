import { z } from 'zod/v4';

import { prisma } from '../../../config/prisma.js';
import { extract, pdfBlock, imageBlock, assertFits } from './ai.service.js';
import { fetchBuffer, signedUrl } from './storage.service.js';
import { normalizeUnit, violatesConvention, expectedUnitFor } from '../lib/units.js';
import { unitForType, TYPE_COLOR, STALE_RATE_DAYS } from '../lib/serializers.js';
import { SECTION_ORDER } from '../lib/codes.js';
import {
  skeletonForPrompt,
  coverageNotes,
  reinforcementWarnings,
  REBAR_DISTRIBUTION,
  LAP_WASTAGE,
  ROOF_DEFAULTS,
} from '../lib/billing-rules.js';

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

// Reading a sheet yields read / counted / derived. Billing adds a fourth:
// `assumed`, for work the drawings never detailed at all. `derived` still means
// "computed from something measured" — a slab volume from a read area and an
// assumed thickness. `assumed` means the quantity rests on a standard rule and
// nothing else. The difference matters to whoever has to check the bill.
const BoqBasis = z.enum(['read', 'counted', 'derived', 'assumed']);

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
      basis: BoqBasis,
      // The rule behind an assumed quantity, in a surveyor's terms. Required
      // whenever the basis is not a direct reading — an assumption nobody can
      // read is indistinguishable from an invention.
      assumption: z.string().nullable(),
      confidence: z.number().min(0).max(1).nullable(),
      rateKey: z.string().nullable(),
      sources: z.array(z.string()),
    })
  ),
  notes: z.array(
    z.object({
      type: z.enum(['success', 'info', 'warning']),
      // Which part of the bill the note belongs to, so a gap shows against its
      // own section rather than only at the head of the bill.
      section: z.string().nullable(),
      text: z.string(),
    })
  ),
});

// The fallback bar-size distribution, rendered for the prompt.
function rebarTable() {
  return Object.entries(REBAR_DISTRIBUTION)
    .map(([element, { ratio, split }]) => {
      const parts = Object.entries(split)
        .map(([size, share]) => `${size} ${Math.round(share * 100)}%`)
        .join(', ');
      return `    ${element}: ${ratio} kg/m³ — ${parts}`;
    })
    .join('\n');
}

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

BASIS AND CONFIDENCE — every item states how its quantity was arrived at:
  "read"     — rests on a dimension, schedule row or annotated area taken off the drawing.
  "counted"  — rests on symbols counted on the sheet.
  "derived"  — computed from something measured plus an assumption (a slab volume from a read area and an assumed thickness).
  "assumed"  — the drawings do not show this work at all; the quantity rests on a standard rule and nothing else.
  Only "read" and "counted" items carry a confidence. "derived" and "assumed" items MUST have confidence null. Do not estimate a confidence for a number nothing measured.

ASSUMPTIONS — set the "assumption" field whenever the basis is "derived" or "assumed", and say the same thing in the description. Write it as a surveyor would, naming the rule and the inputs: "Roof carcass not detailed. Timber at 0.045 m³ per m² of true roof area, on a plan-projected roof of 214 m² with 30° pitch assumed from the elevation." Set it to null only for "read" and "counted" items.

BILL WHAT IS NOT DRAWN — this is where you have previously failed. Do NOT restrict the bill to what the drawings detail. A residential project contains work whose drawings are routinely absent, and leaving it out produces a bill that looks complete and prices short. Where there is geometry to hang an assumption on, BILL THE ITEM with basis "assumed" and a written assumption. Only where there is no geometry at all do you leave it out — and then you must raise a note.

  Roof carcass, when no roof plan was supplied — derive it, do not skip it:
    roof plan area = building footprint + ${ROOF_DEFAULTS.eavesOverhangM} m eaves overhang all round
    pitch          = from an elevation if drawn, otherwise assume ${ROOF_DEFAULTS.pitchDegrees}° (Nigerian aluminium / longspan practice)
    true roof area = plan area ÷ cos(pitch)   [× 1.155 at 30°]
    carcass timber = true roof area × ${ROOF_DEFAULTS.carcassM3PerM2} m³ per m² (rafters 600 c/c, purlins 900 c/c, wall plates, struts)
    covering       = true roof area × ${ROOF_DEFAULTS.coveringLapFactor} for side and end laps
    ceiling        = footprint × 1.0

REINFORCEMENT — never bill one aggregate tonnage. "Reinforcement — 18.4 tonne" cannot be ordered, priced or bent. Emit ONE ITEM PER BAR DIAMETER per element group, naming the size in the description ("High-yield reinforcement, Y16 bars, to foundation bases").
  Sizes: R8, R10, R12 (mild steel — links and stirrups); Y8, Y10, Y12, Y16, Y20, Y25, Y32 (high-yield — main bars). BRC mesh by reference (A142, A193, A252, A393) is billed in m², never tonne.
  Take the sizes, in this order of preference:
    1. A bar bending schedule on the drawing — read it. Those items are basis "read".
    2. Section marks and rebar callouts (4Y16, Y12-150 B/T, R8@200) — parse diameter, count and spacing. Basis "read".
    3. Neither — apply the standard distribution below to the element's steel tonnage, and mark every resulting item basis "assumed" with the rule in the assumption field.
  Standard distribution (kg of steel per m³ of concrete, then split by mass):
${rebarTable()}
  Add ${Math.round(LAP_WASTAGE * 1000) / 10}% for laps and wastage to every bar item, and say so in the description.
  Reinforcement across the whole bill should reconcile to 100-130 kg per m³ of concrete. If yours does not, say so in a note.

COVERAGE — work from the standard bill skeleton below as well as from what was measured. For every entry: bill it (read, counted, derived or assumed), or raise a note saying why you did not. An item you silently omit is the most expensive kind of error, because nothing about the bill looks wrong. Wall screeding is the one that has actually been missed in practice — do not miss it again.
${skeletonForPrompt()}

RATEKEY — set this to the closest matching name from the rate library below, copied EXACTLY. If nothing matches, set it to null. Do NOT invent a price; you are not being asked for one and any figure you supply will be discarded.

SOURCES — list the drawing file names each item was derived from. Never leave this empty.

NOTES — flag what is missing: a discipline with no drawing supplied, a quantity you could not derive, an assumption a surveyor should check. Set "section" to the bill section the note belongs to, or null when it concerns the whole bill. Name the consequence, e.g. "No mechanical or electrical drawings supplied. Services are not billed — expect 12-18% of the contract sum to be missing."

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

    // A quantity nothing measured carries no confidence — the rule this engine
    // was built on, now covering `assumed` as well as `derived`. What such an
    // item carries instead is its basis and the written rule behind it, which
    // is checkable in a way a manufactured percentage never was.
    const measured = item.basis === 'read' || item.basis === 'counted';

    // An assumption that was not written down cannot be checked, so it does not
    // get to pass as one. Say plainly that the rule is missing.
    let assumption = item.assumption?.trim() || null;
    if (!measured && !assumption) {
      assumption = 'The engine did not state the rule behind this quantity. Treat it as unchecked.';
      notes.push({
        type: 'warning',
        section: item.section,
        text: `"${item.description}" is ${item.basis} but no assumption was given. Check the quantity before pricing it.`,
      });
    }

    items.push({
      description: item.description,
      section: SECTION_ORDER.includes(item.section) ? item.section : 'Superstructure',
      unit,
      qty: item.qty,
      // The price comes from the database, never from the model.
      rate: rate && rate.unit === unit ? rate.rateNaira : 0,
      basis: item.basis,
      assumption: measured ? null : assumption,
      confidence: measured ? item.confidence : null,
      sources: item.sources?.length ? item.sources : documents.map((d) => d.name),
    });
  }

  // ── Post-checks ────────────────────────────────────────────────────────────
  // The prompt asks for all of this; these run anyway. A prompt is guidance and
  // a bill is a commercial document, so the two failures that actually cost
  // money — an aggregate steel line, and a trade that quietly vanished — are
  // caught here rather than trusted to have been avoided.
  notes.push(...reinforcementWarnings(items));
  notes.push(...coverageNotes(items));

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

  // ── What the prices are, and when they were true ──────────────────────────
  // A rate is not defensible in a tender without the date it was surveyed on,
  // and in a market that moves 20-40% a year an undated figure is worse than
  // none. The bill therefore carries its own pricing basis, so the screen can
  // say "Lagos rates as at 1 Sep 2026" rather than showing a total that looks
  // timeless.
  const used = rates.filter((r) => r.effectiveFrom);
  const oldest = used.length
    ? used.reduce((a, b) => (a.effectiveFrom < b.effectiveFrom ? a : b)).effectiveFrom
    : null;
  const staleBefore = new Date(Date.now() - STALE_RATE_DAYS * 24 * 60 * 60 * 1000);
  const staleCount = used.filter((r) => r.effectiveFrom < staleBefore).length;

  if (staleCount) {
    notes.push({
      type: 'warning',
      text: `${staleCount} of the rates used were last surveyed more than ${STALE_RATE_DAYS} days ago. Re-price before this bill is issued.`,
    });
  }

  const rateBasis = {
    region,
    asOf: oldest ? oldest.toISOString() : null,
    priced: items.length - unpriced,
    unpriced,
    staleCount,
    demoCount: used.filter((r) => r.isDemo).length,
    libraryEmpty: rates.length === 0,
  };

  if (rateBasis.libraryEmpty) {
    notes.push({
      type: 'warning',
      text: 'Your rate library is empty, so every item is priced at zero. Import a schedule of rates, or add them on the Pricing screen.',
    });
  }

  return { items, notes, rates: rateBasis, usage, model };
}

// ─── Quantifying one described item ──────────────────────────────────────────
//
// Adding a line by hand should not mean measuring it by hand. When a surveyor
// types "225mm sandcrete block wall in cement mortar" into the add-item form,
// the drawings that produced the rest of the bill can usually answer the
// quantity too: the geometry has already been extracted, and what is missing is
// only the mapping from that sentence to it.
//
// This returns a PROPOSAL and stores nothing. The client shows it, the surveyor
// accepts or rejects it, and only then does it go to /boq/items like any other
// line. Nothing is written to a bill on the strength of a sentence alone.

const QuantifySchema = z.object({
  matched: z.boolean(),
  // Why not, when matched is false. Shown to the surveyor verbatim.
  reason: z.string().nullable(),
  section: z
    .enum([
      'Substructure',
      'Superstructure',
      'Roofing',
      'Finishes',
      'Doors & Windows',
      'Services',
      'External Works',
    ])
    .nullable(),
  unit: z.string().nullable(),
  qty: z.number().nullable(),
  basis: BoqBasis.nullable(),
  assumption: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  // The arithmetic, in a line a surveyor can check. Required when matched.
  workings: z.string().nullable(),
  rateKey: z.string().nullable(),
  sources: z.array(z.string()),
  // Nearby items the description might have meant instead — a 225mm wall and a
  // 150mm partition are easy to confuse, and offering both beats guessing.
  alternatives: z
    .array(
      z.object({
        description: z.string(),
        unit: z.string(),
        qty: z.number(),
        confidence: z.number().min(0).max(1).nullable(),
      })
    )
    .max(3),
});

function quantifySystem(rateNames) {
  return `You are a quantity surveyor. A colleague has typed one work item description into a bill and wants the quantity measured from the drawings already analysed for this project.

You will be given the measurements and detected elements taken off those drawings. Your job is to decide what the description refers to and quantify it FROM THAT DATA. You are not reading a drawing here; you are reasoning from quantities already measured.

MATCHING — be semantic, not literal. "blockwork", "9-inch block wall" and "225mm sandcrete blocks" are the same item. If the description plainly refers to work the supplied data cannot reach — a staircase nobody measured, a borehole, a discipline with no drawing — set matched false and say so in "reason". A truthful "no" is worth more than a number, because the surveyor will trust the next answer.

UNITS — return canonical units and respect the measurement conventions:
  in-situ concrete m³ (never m²), formwork m² billed separately, reinforcement tonne by BAR SIZE,
  blockwork and finishes m², excavation m³, pipes and cables m, fittings and doors no.
If the colleague supplied a unit that contradicts the convention, use the correct one and explain in "workings".

BASIS — "read" or "counted" only when your figure rests directly on a measured quantity. "derived" when you computed it from a measured quantity plus an assumption. "assumed" when the data does not contain it and you applied a standard rule. Confidence is a number for read and counted only; it MUST be null for derived and assumed.

WORKINGS — required whenever matched is true. Show the arithmetic in one line, naming the inputs and where they came from: "External wall run 148.2 m (Ground Floor Plan) × 3.0 m storey height = 444.6 m², less openings 32.0 m² = 412.6 m²". The surveyor is accepting a number they did not measure; they must be able to see how it was reached and disagree with it.

ASSUMPTION — whenever basis is derived or assumed, state the rule and its inputs. Null otherwise.

SOURCES — the drawing file names the figure rests on. Never empty when matched is true.

RATEKEY — the closest matching name from the rate library below, copied EXACTLY, or null if nothing matches. Never invent a price; any figure you supply is discarded.

ALTERNATIVES — up to three other readings of the description that the data also supports. Leave empty when the match is unambiguous.

Rate library (names you may use for rateKey):
${rateNames.map((n) => `  - ${n}`).join('\n')}`;
}

export async function quantifyItem({
  description,
  section = null,
  unit = null,
  documents,
  measurements,
  elements,
  orgId,
  region = 'Lagos',
}) {
  const rates = await prisma.buildqRate.findMany({
    where: { region, OR: [{ orgId }, { orgId: null }] },
    orderBy: { orgId: 'desc' },
  });

  const rateByName = new Map();
  for (const r of rates) {
    if (!rateByName.has(r.name)) rateByName.set(r.name, r);
  }

  const payload = {
    request: { description, section, unit },
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
    system: quantifySystem([...rateByName.keys()]),
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    schema: QuantifySchema,
    effort: 'high',
    maxTokens: 4000,
  });

  if (!data.matched) {
    return {
      matched: false,
      reason: data.reason || 'The drawings do not contain enough to measure that item.',
      alternatives: [],
      usage,
      model,
    };
  }

  const normalized = normalizeUnit(data.unit || unit || '');

  // The same guard the generated bill gets. A proposal that breaks a §9
  // convention is refused rather than offered — accepting it is one click, and
  // the whole point of this endpoint is that the surveyor did not do the sums.
  const clash = violatesConvention(description, normalized);
  if (clash) {
    return {
      matched: false,
      reason: `That item is billed in ${clash.expected}, but the measurement available is in ${clash.actual}. Measure it on the takeoff screen instead.`,
      alternatives: [],
      usage,
      model,
    };
  }

  const measured = data.basis === 'read' || data.basis === 'counted';
  const rate = data.rateKey ? rateByName.get(data.rateKey) : null;
  const priced = rate && rate.unit === normalized ? rate : null;

  return {
    matched: true,
    section: data.section || section || 'Superstructure',
    unit: normalized,
    qty: data.qty ?? 0,
    basis: data.basis,
    assumption: measured ? null : data.assumption || null,
    confidence: measured ? data.confidence : null,
    workings: data.workings || null,
    rate: priced ? priced.rateNaira : 0,
    // A rate is only defensible with the date it was surveyed on (§9).
    rateAsOf: priced ? priced.effectiveFrom : null,
    rateSource: priced ? priced.source : null,
    rateIsDemo: priced ? priced.isDemo : false,
    unpricedReason: priced
      ? null
      : rate
        ? `The library rate "${rate.name}" is per ${rate.unit}, not ${normalized}.`
        : 'No rate in your library matches this item.',
    sources: data.sources?.length ? data.sources : documents.map((d) => d.name),
    alternatives: (data.alternatives || []).map((a) => ({
      description: a.description,
      unit: normalizeUnit(a.unit),
      qty: a.qty,
      confidence: a.confidence,
    })),
    usage,
    model,
  };
}
