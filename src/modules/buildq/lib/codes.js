import crypto from 'node:crypto';
import { PAYMENT_PURPOSES } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Human-facing identifiers.
//
// §13 gives projects and variations a `code` column alongside their surrogate
// id; documents, rates, BOQ items and cost lines have no code, so those expose
// their cuid directly. The frontend treats every id as opaque.
// ─────────────────────────────────────────────────────────────────────────────

// PRJ- + 4 digits. Collisions are possible, so callers retry — see nextProjectCode.
export function randomProjectCode() {
  return `PRJ-${1000 + crypto.randomInt(9000)}`;
}

// Allocates a project code that is not already taken.
export async function nextProjectCode(prisma) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = randomProjectCode();
    const clash = await prisma.buildqProject.findUnique({ where: { code } });
    if (!clash) return code;
  }
  // Astronomically unlikely; fall back to something guaranteed unique.
  return `PRJ-${Date.now().toString(36).toUpperCase()}`;
}

// VO- + 3 digits, zero-padded, sequential within the project.
export async function nextVariationCode(prisma, projectId) {
  const last = await prisma.buildqVariation.findFirst({
    where: { projectId },
    orderBy: { code: 'desc' },
    select: { code: true },
  });
  const n = last ? Number(String(last.code).replace(/\D/g, '')) || 0 : 0;
  return `VO-${String(n + 1).padStart(3, '0')}`;
}

// {PREFIX}-{base36 timestamp}-{6 random chars} (spec §15).
export function paymentReference(purpose) {
  const prefix = PAYMENT_PURPOSES[purpose];
  if (!prefix) throw new Error(`Unknown payment purpose: ${purpose}`);
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(4).toString('base64url').replace(/[^A-Z0-9]/gi, '').slice(0, 6).toUpperCase();
  return `${prefix}-${stamp}-${rand.padEnd(6, 'X')}`;
}

// ─── BOQ sections (spec §6) ──────────────────────────────────────────────────
export const SECTION_ORDER = [
  'Substructure',
  'Superstructure',
  'Roofing',
  'Finishes',
  'Doors & Windows',
  'Services',
  'External Works',
];

export const SECTION_LETTER = {
  Substructure: 'A',
  Superstructure: 'B',
  Roofing: 'C',
  Finishes: 'D',
  'Doors & Windows': 'E',
  Services: 'F',
  'External Works': 'G',
};

// Code format: {letter}{ceil(n/3)}.{((n-1) % 3) + 1} where n is the item's
// ordinal within its section — A1.1, A1.2, A1.3, A2.1, A2.2 …
export function boqCode(section, ordinal) {
  const letter = SECTION_LETTER[section] || 'H';
  const group = Math.ceil(ordinal / 3);
  const index = ((ordinal - 1) % 3) + 1;
  return `${letter}${group}.${index}`;
}

// Renumber a full list of items into bill order, assigning codes and sort order.
// Returns a new array; does not mutate the input.
export function renumber(items) {
  const bySection = new Map();
  const ordered = [...items].sort((a, b) => {
    const ai = SECTION_ORDER.indexOf(a.section);
    const bi = SECTION_ORDER.indexOf(b.section);
    if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  });

  return ordered.map((item, i) => {
    const n = (bySection.get(item.section) || 0) + 1;
    bySection.set(item.section, n);
    return { ...item, code: boqCode(item.section, n), sortOrder: i };
  });
}
