// ─────────────────────────────────────────────────────────────────────────────
// Units of measurement — the server-side twin of the frontend's utils/units.js.
//
// §9 is the section where errors are most expensive: billing concrete in m²
// instead of m³ inflates a line by roughly the reciprocal of the slab
// thickness — a factor of ~6.7 at 150 mm. Both ends of the wire therefore
// agree on one canonical spelling per unit, and on what each unit measures, so
// a quantity can never be priced at a rate of a different dimension.
//
// Kept deliberately identical to the frontend table. If you change one, change
// both.
// ─────────────────────────────────────────────────────────────────────────────

export const UNITS = {
  // Linear
  m: { label: 'metre', dimension: 'length' },
  km: { label: 'kilometre', dimension: 'length' },
  mm: { label: 'millimetre', dimension: 'length' },

  // Area / volume
  'm²': { label: 'square metre', dimension: 'area' },
  'm³': { label: 'cubic metre', dimension: 'volume' },

  // Discrete
  no: { label: 'number', dimension: 'count' },
  pair: { label: 'pair', dimension: 'count' },
  set: { label: 'set', dimension: 'count' },

  // Mass
  kg: { label: 'kilogramme', dimension: 'mass' },
  tonne: { label: 'tonne', dimension: 'mass' },

  // Capacity
  L: { label: 'litre', dimension: 'capacity' },

  // Time / plant hire
  hr: { label: 'hour', dimension: 'time' },
  day: { label: 'day', dimension: 'time' },
  week: { label: 'week', dimension: 'time' },
  month: { label: 'month', dimension: 'time' },

  // Trade packaging
  bag: { label: 'bag', dimension: 'pack' },
  bucket: { label: 'bucket', dimension: 'pack' },
  tin: { label: 'tin', dimension: 'pack' },
  roll: { label: 'roll', dimension: 'pack' },
  pack: { label: 'pack', dimension: 'pack' },
  sheet: { label: 'sheet', dimension: 'pack' },
  length: { label: 'length', dimension: 'pack' },
  trip: { label: 'trip', dimension: 'pack' },
  load: { label: 'load', dimension: 'pack' },
  trailer: { label: 'trailer', dimension: 'pack' },

  // Lump sums
  item: { label: 'item', dimension: 'lump' },
  sum: { label: 'sum', dimension: 'lump' },
};

const ALIASES = {
  metre: 'm', metres: 'm', meter: 'm', meters: 'm', lm: 'm', 'l.m': 'm', rm: 'm', m1: 'm',
  millimetre: 'mm', millimeter: 'mm',
  kilometre: 'km', kilometer: 'km',

  m2: 'm²', 'm^2': 'm²', sqm: 'm²', 'sq.m': 'm²', 'sq m': 'm²', sqmt: 'm²',
  'square metre': 'm²', 'square meter': 'm²', sm: 'm²', '㎡': 'm²',

  m3: 'm³', 'm^3': 'm³', cum: 'm³', 'cu.m': 'm³', 'cu m': 'm³', cbm: 'm³',
  'cubic metre': 'm³', 'cubic meter': 'm³', '㎥': 'm³',

  nr: 'no', 'no.': 'no', num: 'no', number: 'no', pcs: 'no', pc: 'no', piece: 'no',
  pieces: 'no', ea: 'no', each: 'no', unit: 'no', units: 'no', qty: 'no',
  prs: 'pair', pairs: 'pair', sets: 'set',

  kilo: 'kg', kilos: 'kg', kgs: 'kg', kilogram: 'kg', kilogramme: 'kg',
  t: 'tonne', ton: 'tonne', tons: 'tonne', tonnes: 'tonne', mt: 'tonne',

  l: 'L', ltr: 'L', litre: 'L', litres: 'L', liter: 'L', liters: 'L',

  hour: 'hr', hours: 'hr', hrs: 'hr', days: 'day', wk: 'week', weeks: 'week',
  mth: 'month', months: 'month',

  bags: 'bag', buckets: 'bucket', tins: 'tin', rolls: 'roll', packs: 'pack',
  packet: 'pack', sheets: 'sheet', lengths: 'length', trips: 'trip', loads: 'load',

  ls: 'sum', 'lump sum': 'sum', items: 'item',
};

// Unknown units are returned trimmed rather than discarded — a QS may have a
// legitimate unit we have not listed, and dropping it silently would be worse.
export function normalizeUnit(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';

  if (UNITS[s]) return s; // case-sensitive: m² and L matter

  const lower = s.toLowerCase().replace(/\s+/g, ' ');
  if (UNITS[lower]) return lower;
  if (ALIASES[lower]) return ALIASES[lower];

  const stripped = lower.replace(/[.\s]+$/g, '').replace(/[.]/g, '');
  if (UNITS[stripped]) return stripped;
  if (ALIASES[stripped]) return ALIASES[stripped];

  const collapsed = stripped.replace(/\s/g, '');
  if (ALIASES[collapsed]) return ALIASES[collapsed];

  return s;
}

export function dimensionOf(unit) {
  return UNITS[normalizeUnit(unit)]?.dimension ?? null;
}

// A rate may only be applied to a quantity of the same dimension. Unknown units
// return true — we cannot prove a mismatch, so we do not block the user.
export function sameDimension(a, b) {
  const da = dimensionOf(a);
  const db = dimensionOf(b);
  if (da === null || db === null) return true;
  return da === db;
}

export function isKnownUnit(unit) {
  return Boolean(UNITS[normalizeUnit(unit)]);
}

// ─── Measurement conventions (§9) ────────────────────────────────────────────
// The unit a trade must be billed in. Used to check engine output before it
// reaches a bill: concrete is always m³, formwork always m², steel always tonne.
export const TRADE_UNITS = {
  'site clearance': 'm²',
  'topsoil removal': 'm²',
  excavation: 'm³',
  filling: 'm³',
  hardcore: 'm³',
  concrete: 'm³',
  blinding: 'm³',
  formwork: 'm²',
  reinforcement: 'tonne',
  blockwork: 'm²',
  walling: 'm²',
  plaster: 'm²',
  render: 'm²',
  paint: 'm²',
  tiling: 'm²',
  screed: 'm²',
  'damp-proof membrane': 'm²',
  'roof covering': 'm²',
  ceiling: 'm²',
  fascia: 'm',
  skirting: 'm',
  ridge: 'm',
  pipe: 'm',
  cable: 'm',
  door: 'no',
  'sanitary fitting': 'no',
  socket: 'no',
  light: 'no',
};

// Returns the expected unit for a work-item description, or null when no
// convention applies. Longest keyword wins so "damp-proof membrane" is not
// matched by a shorter, wrong entry.
export function expectedUnitFor(description) {
  const text = String(description || '').toLowerCase();
  let best = null;
  for (const [keyword, unit] of Object.entries(TRADE_UNITS)) {
    if (text.includes(keyword) && (!best || keyword.length > best.keyword.length)) {
      best = { keyword, unit };
    }
  }
  return best ? best.unit : null;
}

// True when a description and unit disagree with §9 — e.g. concrete in m².
export function violatesConvention(description, unit) {
  const expected = expectedUnitFor(description);
  if (!expected) return null;
  const actual = normalizeUnit(unit);
  return expected === actual ? null : { expected, actual };
}
