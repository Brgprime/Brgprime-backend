// ─────────────────────────────────────────────────────────────────────────────
// Wire shapes.
//
// The database uses clean, explicit column names; the Vue stores read a
// different, older vocabulary (`desc`, `cat`, `reviews`, `source`). §6 permits
// exactly this: "Keep them, or provide a mapping layer." This is that layer, and
// it is the ONLY place the two vocabularies meet — no controller emits raw rows.
//
// Two conversions matter and are easy to get silently wrong:
//   • confidence is stored 0–1 (the engine contract, §12) and emitted 0–100
//     (the domain model, §6). The spec defines it both ways; the DB picks one.
//   • money is stored BigInt and emitted as a Number.
// ─────────────────────────────────────────────────────────────────────────────

const NAIRA = '₦';

// First letter of first word + first letter of last word, uppercased.
// Single word → first two letters. Empty → "??". Mirrors stores/auth.js.
export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function sizeLabel(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const num = (v) => (v === null || v === undefined ? v : Number(v));
const iso = (d) => (d ? new Date(d).toISOString() : null);

// Stored 0–1 → emitted 0–100. null stays null: a confidence that was never
// measured must not become a number.
export const toPercentConfidence = (c) =>
  c === null || c === undefined ? null : Math.round(c * 100);

// ─── Project ─────────────────────────────────────────────────────────────────
export function serializeProject(p) {
  if (!p) return null;
  const members = p.members || [];
  return {
    id: p.code,
    name: p.name,
    client: p.client,
    location: p.location,
    type: p.type,
    status: p.status,
    progress: p.progress,
    budget: num(p.budget),
    spent: num(p.spent),
    currency: p.currency === 'NGN' ? NAIRA : p.currency,
    updated: iso(p.updatedAt),
    createdAt: iso(p.createdAt),
    cover: p.cover,
    // Initials keep the existing UI rendering; `members` carries the real ids
    // the spec asks us to move to.
    team: members.map((m) => initials(m.user?.name)),
    members: members.map((m) => ({
      id: m.userId,
      name: m.user?.name,
      avatar: initials(m.user?.name),
      role: m.role,
    })),
  };
}

// ─── Document ────────────────────────────────────────────────────────────────
export function serializeDocument(d) {
  if (!d) return null;
  return {
    id: d.id,
    name: d.name,
    ext: d.ext,
    kind: d.kind,
    size: d.sizeBytes,
    sizeLabel: sizeLabel(d.sizeBytes),
    mime: d.mime,
    scope: d.project?.code || (d.projectId ? d.projectId : 'library'),
    uploadedBy: d.uploadedBy?.name || 'You',
    uploadedAt: iso(d.uploadedAt),
    status: d.status,
    pageCount: d.pageCount ?? null,
    detectedScale: d.detectedScale ?? null,
    // Real count of what the engine actually recognised — 0, not a fabricated
    // "8 + filename.length % 14".
    elements: d._count?.elements ?? d.elements?.length ?? 0,
  };
}

// ─── BOQ ─────────────────────────────────────────────────────────────────────
export function serializeBoqItem(i) {
  if (!i) return null;
  return {
    id: i.id,
    code: i.code,
    desc: i.description,
    section: i.section,
    unit: i.unit,
    qty: i.qty,
    rate: i.rate,
    confidence: toPercentConfidence(i.confidence),
    sources: i.sources || [],
  };
}

export function serializeBoqRevision(r) {
  if (!r) return null;
  return {
    id: r.id,
    version: r.version,
    source: r.source,
    standard: r.standard,
    region: r.region,
    generatedFrom: r.generatedFrom || [],
    notes: r.notes || [],
    createdAt: iso(r.createdAt),
    createdBy: r.createdBy?.name || null,
    itemCount: r._count?.items ?? r.items?.length ?? 0,
  };
}

// ─── Measurement (takeoff) ───────────────────────────────────────────────────
const TYPE_UNIT = { Linear: 'm', Area: 'm²', Volume: 'm³', Count: 'no' };
export const TYPE_COLOR = { Linear: '#2DC875', Area: '#1CA5F6', Volume: '#FFA726', Count: '#E63946' };

export function unitForType(type) {
  return TYPE_UNIT[type] || 'no';
}

export function serializeMeasurement(m) {
  if (!m) return null;
  return {
    id: m.id,
    name: m.name,
    type: m.type,
    value: `${m.value} ${m.unit}`,
    numeric: m.value,
    unit: m.unit,
    color: m.color,
    auto: m.auto,
    // 0–100, the same scale serializeBoqItem emits and the takeoff screen
    // renders. The §12 engine contract keeps 0–1 and is built separately in
    // analysis.controller's engineShape, so the two do not collide.
    confidence: toPercentConfidence(m.confidence),
    source: m.document?.name || null,
    documentId: m.documentId,
  };
}

// ─── Variation ───────────────────────────────────────────────────────────────
export function serializeVariation(v) {
  if (!v) return null;
  const rev =
    v.revisionFrom && v.revisionTo ? `Rev ${v.revisionFrom} → Rev ${v.revisionTo}` : null;
  return {
    id: v.code,
    title: v.title,
    description: v.description,
    rev,
    // Signed: negative for an omission (§6).
    impact: num(v.impactNaira),
    status: v.status,
    date: iso(v.raisedAt),
    by: initials(v.raisedBy?.name),
    decidedAt: iso(v.decidedAt),
    decidedBy: v.decidedBy ? initials(v.decidedBy.name) : null,
  };
}

// ─── Rate ────────────────────────────────────────────────────────────────────
// `change` is the % movement over 30 days, computed from rate_history. 0 means
// "no earlier reading", not "no movement" — there is no way to distinguish them
// in the frontend's shape, so `hasHistory` is included alongside.
export function serializeRate(r, change = 0, hasHistory = false, changeSince = null) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    cat: r.category,
    unit: r.unit,
    rate: r.rateNaira,
    change,
    hasHistory,
    // Which earlier reading `change` was measured against, so the UI can say
    // "since 3 May" rather than implying a full 30-day window it may not have.
    changeSince,
    region: r.region,
    source: r.source,
    isDemo: r.isDemo,
    scope: r.orgId ? 'organization' : 'global',
    effectiveFrom: iso(r.effectiveFrom),
  };
}

// ─── Cost line ───────────────────────────────────────────────────────────────
export function serializeCostLine(c) {
  if (!c) return null;
  return {
    id: c.id,
    item: c.item,
    unit: c.unit,
    rate: c.rate,
    qty: c.qty,
    section: c.section,
    source: c.sourceFile,
    uploadedAt: iso(c.uploadedAt),
  };
}

// ─── Region ──────────────────────────────────────────────────────────────────
export function serializeRegion(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    material: r.materialFactor,
    labour: r.labourFactor,
    equipment: r.equipmentFactor,
    // null when no real benchmark exists — the client must render "no data"
    // rather than a number we invented.
    benchmark: r.benchmarkNaira === null ? null : num(r.benchmarkNaira),
    isDemo: r.isDemo,
  };
}

// ─── Vendor ──────────────────────────────────────────────────────────────────
// §16 lists this as a High-severity leak: today the contacts are in the payload
// and merely blurred by CSS, so anyone can read them in devtools. Here they are
// simply absent from the response until the caller's organization has paid to
// unlock, or owns the listing.
//
// The stripping is subtractive by construction — contact fields are added to
// the object only in the unlocked branch, so a future field cannot leak by
// being forgotten in a delete list.
export function serializeVendor(v, { unlocked = false, ownedByOrgId = null } = {}) {
  if (!v) return null;
  const owned = Boolean(ownedByOrgId && v.ownerOrgId === ownedByOrgId);
  const revealed = unlocked || owned;

  const base = {
    id: v.id,
    name: v.name,
    category: v.category,
    location: v.location,
    rating: v.rating,
    reviews: v.reviewsCount,
    years: v.years,
    verified: v.verified,
    unlockPrice: v.unlockPrice,
    description: v.description,
    status: v.status,
    products: (v.products || []).map((p) => ({
      id: p.id,
      name: p.name,
      unit: p.unit,
      price: p.priceNaira,
    })),
    // The UI needs to know whether to show the unlock button — not the details.
    unlocked: revealed,
    owned,
    ...(owned ? { createdAt: iso(v.createdAt) } : {}),
  };

  if (!revealed) return base;

  return { ...base, phone: v.phone, email: v.email, whatsapp: v.whatsapp };
}

// ─── Activity ────────────────────────────────────────────────────────────────
export function serializeActivity(a) {
  if (!a) return null;
  return {
    id: a.id,
    user: a.actor ? initials(a.actor.name) : 'AI',
    action: a.action,
    target: a.target,
    time: iso(a.createdAt),
    type: a.type,
  };
}
