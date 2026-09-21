// ─────────────────────────────────────────────────────────────────────────────
// Billing rules — the surveying knowledge the engine was missing.
//
// The engine could read a drawing and bill what it saw. Three things it could
// not do, all reported from real use:
//
//   1. It billed reinforcement as one aggregate tonnage. "Reinforcement —
//      18.4 tonne" is not a billable item: bar sizes carry different rates and
//      different suppliers, and a bender cannot work from a total.
//
//   2. It stayed silent about work the drawings did not detail. A roof with no
//      roof plan produced no carcass at all, rather than a stated assumption a
//      surveyor could check.
//
//   3. It billed only what it detected, so an item nobody drew — wall
//      screeding is the one that was noticed — simply vanished. A bill with a
//      missing line still looks finished, which is what makes it expensive.
//
// The tables below are the answer to all three. They are ASSUMPTIONS for
// Nigerian residential work, not measurements, and every figure derived from
// them is labelled `assumed` so it reads as what it is.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Reinforcement ───────────────────────────────────────────────────────────

/** Mild steel — links and stirrups. */
export const MILD_STEEL_SIZES = ['R8', 'R10', 'R12'];

/** High-yield — main bars. */
export const HIGH_YIELD_SIZES = ['Y8', 'Y10', 'Y12', 'Y16', 'Y20', 'Y25', 'Y32'];

export const REBAR_SIZES = [...MILD_STEEL_SIZES, ...HIGH_YIELD_SIZES];

/** BRC mesh, which is billed by area rather than by mass. */
export const MESH_REFS = ['A98', 'A142', 'A193', 'A252', 'A393'];

/**
 * Fallback bar-size distribution, applied to an element's total steel tonnage
 * ONLY when the drawing carries no bending schedule and no rebar callouts.
 *
 * `ratio` is kg of steel per m³ of concrete. The proportions are of that mass.
 * Anything derived from this table is `assumed`, never `measured`.
 */
export const REBAR_DISTRIBUTION = {
  Foundations: { ratio: 90, split: { Y16: 0.55, Y12: 0.35, R8: 0.1 } },
  Columns: { ratio: 140, split: { Y20: 0.45, Y16: 0.3, R8: 0.25 } },
  Beams: { ratio: 130, split: { Y20: 0.35, Y16: 0.35, Y12: 0.1, R8: 0.2 } },
  Slabs: { ratio: 110, split: { Y16: 0.2, Y12: 0.75, R8: 0.05 } },
};

/** Laps and wastage, added to every bar item and stated in its description. */
export const LAP_WASTAGE = 0.075;

/**
 * Project-wide sanity band, kg of steel per m³ of concrete (§9). The engine
 * flags a bill that falls outside it rather than quietly issuing it.
 */
export const STEEL_RATIO_BAND = { min: 90, max: 130 };

// No trailing \b on the stem: "reinforc" is followed by "ement" or "ed", both
// word characters, so a closing boundary would never match the words this is
// looking for.
const REBAR_RE = /(reinforc\w*|rebar|high[- ]?yield|mild steel|bar bending|BRC|mesh)/i;
const SIZE_RE = /\b([RY])\s?(8|10|12|16|20|25|32)\b/i;
const MESH_RE = /\bA\s?(98|142|193|252|393)\b/i;

// "Reinforced concrete" is a concrete item measured in m³, not a steel one.
// Without this, every concrete line would be asked to name a bar size.
const CONCRETE_RE = /concrete|blinding/i;

export function isReinforcementItem(description = '') {
  const d = String(description);
  return REBAR_RE.test(d) && !CONCRETE_RE.test(d);
}

/** The bar size named in a description, canonicalised — or null. */
export function rebarSizeOf(description = '') {
  const mesh = String(description).match(MESH_RE);
  if (mesh) return `A${mesh[1]}`;
  const m = String(description).match(SIZE_RE);
  return m ? `${m[1].toUpperCase()}${m[2]}` : null;
}

/**
 * Catches the failure this module exists for: a reinforcement line that names
 * no bar size is an aggregate, and an aggregate cannot be ordered or bent.
 */
export function reinforcementWarnings(items = []) {
  const notes = [];
  const rebar = items.filter((i) => isReinforcementItem(i.description));

  for (const item of rebar) {
    if (!rebarSizeOf(item.description)) {
      notes.push({
        type: 'warning',
        section: item.section,
        text: `"${item.description}" names no bar size. Reinforcement must be billed one item per diameter (Y12, Y16, R8 links and so on) — a single tonnage cannot be ordered, priced or bent.`,
      });
    }
  }

  // Steel that is billed but reconciles to nothing is the other direction of
  // the same error, and it is the one that silently under-prices a tender.
  const steelTonnes = rebar
    .filter((i) => i.unit === 'tonne')
    .reduce((sum, i) => sum + (Number(i.qty) || 0), 0);
  const concreteM3 = items
    .filter((i) => i.unit === 'm³' && /concrete/i.test(i.description))
    .reduce((sum, i) => sum + (Number(i.qty) || 0), 0);

  if (concreteM3 > 0 && steelTonnes > 0) {
    const ratio = (steelTonnes * 1000) / concreteM3;
    if (ratio < STEEL_RATIO_BAND.min || ratio > STEEL_RATIO_BAND.max) {
      notes.push({
        type: 'warning',
        section: 'Substructure',
        text: `Reinforcement works out at ${Math.round(ratio)} kg per m³ of concrete. Typical residential work is ${STEEL_RATIO_BAND.min}-${STEEL_RATIO_BAND.max} kg/m³, so check the steel before this bill is issued.`,
      });
    }
  } else if (concreteM3 > 0 && steelTonnes === 0) {
    notes.push({
      type: 'warning',
      section: 'Substructure',
      text: `${Math.round(concreteM3)} m³ of concrete is billed with no reinforcement against it. Reinforced concrete carries roughly ${STEEL_RATIO_BAND.min}-${STEEL_RATIO_BAND.max} kg of steel per m³.`,
    });
  }

  return notes;
}

// ─── Roof carcass ────────────────────────────────────────────────────────────
//
// The case the engine used to give up on. A roof is derivable from the
// footprint and the elevations; where the elevations are absent, a pitch can be
// assumed for the region. An assumed carcass a surveyor can correct beats an
// absent one they have to notice.

export const ROOF_DEFAULTS = {
  eavesOverhangM: 0.6,
  pitchDegrees: 30,
  /** m³ of timber per m² of true roof area: rafters 600 c/c, purlins 900 c/c,
   *  wall plates and struts. */
  carcassM3PerM2: 0.045,
  /** Side and end laps on sheet coverings. */
  coveringLapFactor: 1.1,
};

/**
 * Roof quantities from a building footprint. Every figure this returns is an
 * assumption; the caller must label it so.
 */
export function roofFromFootprint(footprintM2, { pitchDegrees = ROOF_DEFAULTS.pitchDegrees } = {}) {
  const footprint = Number(footprintM2) || 0;
  if (footprint <= 0) return null;

  // Growing the area by the eaves is an approximation of growing the perimeter;
  // for an ordinary rectangular footprint it is within a few percent, and it is
  // the only thing available when the plan outline itself was not measured.
  const perimeterApprox = 4 * Math.sqrt(footprint);
  const planArea = footprint + perimeterApprox * ROOF_DEFAULTS.eavesOverhangM;
  const trueArea = planArea / Math.cos((pitchDegrees * Math.PI) / 180);

  return {
    pitchDegrees,
    planAreaM2: round2(planArea),
    trueAreaM2: round2(trueArea),
    carcassM3: round2(trueArea * ROOF_DEFAULTS.carcassM3PerM2),
    coveringM2: round2(trueArea * ROOF_DEFAULTS.coveringLapFactor),
    ceilingM2: round2(footprint),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ─── The standard bill skeleton ──────────────────────────────────────────────
//
// What a residential bill contains, whether or not the drawings happen to show
// it. The engine bills from this list as well as from what it detected; an
// entry it cannot bill produces a note naming the gap.
//
// `match` decides whether an entry has been satisfied by something already in
// the bill. `dependsOn` is the geometry the quantity needs, and is what the
// note explains when it is missing.

export const BILL_SKELETON = [
  // ── Substructure ──
  {
    key: 'site-clearance',
    section: 'Substructure',
    label: 'Site clearance and removal of topsoil',
    unit: 'm²',
    dependsOn: 'the site outline',
    match: /site clear|topsoil|vegetation strip/i,
  },
  {
    key: 'excavation',
    section: 'Substructure',
    label: 'Excavation for foundations',
    unit: 'm³',
    dependsOn: 'the foundation layout',
    match: /excavat/i,
  },
  {
    key: 'disposal',
    section: 'Substructure',
    label: 'Disposal of excavated material',
    unit: 'm³',
    dependsOn: 'the excavation volume',
    derive: 'excavation volume × 1.25 for bulking',
    match: /disposal|cart away|remove (surplus|spoil)/i,
  },
  {
    key: 'hardcore',
    section: 'Substructure',
    label: 'Hardcore filling under floor slab',
    unit: 'm³',
    dependsOn: 'the building footprint',
    derive: 'footprint × 0.15',
    match: /hardcore|hard core|laterite fill/i,
  },
  {
    key: 'blinding',
    section: 'Substructure',
    label: 'Plain concrete blinding',
    unit: 'm³',
    dependsOn: 'the building footprint',
    derive: 'footprint × 0.05',
    match: /blinding/i,
  },
  {
    key: 'dpm',
    section: 'Substructure',
    label: 'Damp-proof membrane under slab',
    unit: 'm²',
    dependsOn: 'the building footprint',
    match: /damp[- ]?proof|DPM\b|polythene sheet/i,
  },
  {
    key: 'anti-termite',
    section: 'Substructure',
    label: 'Anti-termite soil treatment',
    unit: 'm²',
    dependsOn: 'the building footprint',
    match: /anti[- ]?termite|termite treatment/i,
  },

  // ── Superstructure ──
  {
    key: 'lintels',
    section: 'Superstructure',
    label: 'Reinforced concrete lintels over openings',
    unit: 'm³',
    dependsOn: 'the door and window schedule',
    derive: 'opening width + 0.45 m bearing, 225 × 150 mm section',
    match: /lintel/i,
  },

  // ── Roofing ──
  {
    key: 'roof-carcass',
    section: 'Roofing',
    label: 'Roof carcass — rafters, purlins, wall plates and struts',
    unit: 'm³',
    dependsOn: 'the building footprint',
    derive: `${ROOF_DEFAULTS.carcassM3PerM2} m³ per m² of true roof area`,
    match: /rafter|purlin|roof (carcass|timber|truss)|wall plate/i,
  },
  {
    key: 'roof-covering',
    section: 'Roofing',
    label: 'Roof covering',
    unit: 'm²',
    dependsOn: 'the roof area',
    match: /roof(ing)? (sheet|cover|tile)|longspan|stone[- ]?coated|aluminium roof/i,
  },
  {
    key: 'fascia',
    section: 'Roofing',
    label: 'Fascia and barge board',
    unit: 'm',
    dependsOn: 'the roof perimeter',
    match: /fascia|barge/i,
  },
  {
    key: 'rainwater',
    section: 'Roofing',
    label: 'Rainwater gutters and downpipes',
    unit: 'm',
    dependsOn: 'the eaves length',
    match: /gutter|downpipe|rainwater/i,
  },
  {
    key: 'ceiling',
    section: 'Roofing',
    label: 'Ceiling finish',
    unit: 'm²',
    dependsOn: 'the floor area',
    match: /ceiling/i,
  },

  // ── Finishes ── the section the reported gap came from
  {
    key: 'render-internal',
    section: 'Finishes',
    label: 'Cement/sand render (screeding) to walls, internal',
    unit: 'm²',
    dependsOn: 'the wall area',
    derive: 'both faces of internal walls and the inner face of external walls, less openings',
    match: /(render|screed|plaster).*(internal|inside|inner)|internal.*(render|screed|plaster)/i,
  },
  {
    key: 'render-external',
    section: 'Finishes',
    label: 'Cement/sand render (screeding) to walls, external',
    unit: 'm²',
    dependsOn: 'the external wall area',
    derive: 'outer face of external walls, less openings',
    match: /(render|screed|plaster).*(external|outside|outer)|external.*(render|screed|plaster)/i,
  },
  {
    key: 'floor-screed',
    section: 'Finishes',
    label: 'Cement/sand screed to floors',
    unit: 'm²',
    dependsOn: 'the floor area',
    match: /floor screed|screed to floor|granolithic/i,
  },
  {
    key: 'floor-finish',
    section: 'Finishes',
    label: 'Floor finish (tiling or similar)',
    unit: 'm²',
    dependsOn: 'the floor area',
    match: /floor tile|tiling to floor|vitrified|ceramic floor|terrazzo/i,
  },
  {
    key: 'painting',
    section: 'Finishes',
    label: 'Paint to walls and ceilings',
    unit: 'm²',
    dependsOn: 'the rendered area',
    match: /paint|emulsion|gloss|textured coating/i,
  },
  {
    key: 'skirting',
    section: 'Finishes',
    label: 'Skirting',
    unit: 'm',
    dependsOn: 'the room perimeters',
    match: /skirting/i,
  },

  // ── Doors & Windows ──
  {
    key: 'doors',
    section: 'Doors & Windows',
    label: 'Doors, frames and ironmongery',
    unit: 'no',
    dependsOn: 'the door schedule',
    match: /door/i,
  },
  {
    key: 'windows',
    section: 'Doors & Windows',
    label: 'Windows',
    unit: 'm²',
    dependsOn: 'the window schedule',
    match: /window|casement|sliding glaz/i,
  },

  // ── Services ──
  {
    key: 'electrical',
    section: 'Services',
    label: 'Electrical installation',
    unit: 'no',
    dependsOn: 'an electrical layout drawing',
    match: /socket|light (point|fitting)|cable|conduit|distribution board|electrical/i,
  },
  {
    key: 'plumbing',
    section: 'Services',
    label: 'Plumbing and sanitary installation',
    unit: 'no',
    dependsOn: 'a mechanical or plumbing layout drawing',
    match: /sanitary|water closet|\bWC\b|wash hand|soil pipe|plumbing|pipework/i,
  },
];

/**
 * Which skeleton entries the bill does not cover.
 *
 * Returns entries, not notes, so the caller decides how loudly to say it — the
 * engine turns them into a prompt, the controller turns them into warnings.
 */
export function coverageGaps(items = []) {
  const billed = items.map((i) => `${i.description} ${i.section}`).join('\n');
  return BILL_SKELETON.filter((entry) => !entry.match.test(billed));
}

/** Coverage gaps as bill notes, grouped so the bill does not drown in them. */
export function coverageNotes(items = []) {
  const gaps = coverageGaps(items);
  if (!gaps.length) return [];

  const bySection = new Map();
  for (const gap of gaps) {
    if (!bySection.has(gap.section)) bySection.set(gap.section, []);
    bySection.get(gap.section).push(gap);
  }

  return [...bySection.entries()].map(([section, entries]) => ({
    type: 'warning',
    section,
    text: `Not billed in ${section}: ${entries
      .map((e) => e.label.toLowerCase())
      .join('; ')}. ${
      entries.length === 1 ? 'This item is' : 'These items are'
    } normally measured on a project of this kind — either the drawings do not show ${
      entries.length === 1 ? 'it' : 'them'
    }, or ${entries.length === 1 ? 'it was' : 'they were'} missed. Check before issuing.`,
  }));
}

/** A compact description of the skeleton, for the BOQ prompt. */
export function skeletonForPrompt() {
  const bySection = new Map();
  for (const entry of BILL_SKELETON) {
    if (!bySection.has(entry.section)) bySection.set(entry.section, []);
    bySection.get(entry.section).push(entry);
  }
  return [...bySection.entries()]
    .map(([section, entries]) => {
      const lines = entries.map((e) => {
        const how = e.derive ? ` — ${e.derive}` : '';
        return `    ${e.label} (${e.unit}), needs ${e.dependsOn}${how}`;
      });
      return `  ${section}:\n${lines.join('\n')}`;
    })
    .join('\n');
}
