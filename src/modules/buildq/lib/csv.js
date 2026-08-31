// ─────────────────────────────────────────────────────────────────────────────
// Tolerant CSV parsing, matching the frontend's importer.
//
// Real cost schedules arrive from Excel with quoted fields, BOM headers, blank
// rows, currency symbols and thousands separators. The parser accepts all of
// that; what it will not do is guess at a missing column.
// ─────────────────────────────────────────────────────────────────────────────

// Splits a line respecting double-quoted fields with "" escapes.
function splitLine(line) {
  const out = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      out.push(field);
      field = '';
    } else {
      field += c;
    }
  }
  out.push(field);
  return out.map((f) => f.trim());
}

const normalizeHeader = (h) =>
  String(h || '')
    .replace(/^﻿/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

// Parses to an array of objects keyed by normalized header.
export function parseCsv(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  if (!lines.length) return { headers: [], rows: [] };

  const headers = splitLine(lines[0]).map(normalizeHeader);
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitLine(lines[i]);
    if (cells.every((c) => c === '')) continue;
    const row = {};
    headers.forEach((h, idx) => {
      if (h) row[h] = cells[idx] ?? '';
    });
    rows.push(row);
  }
  return { headers, rows };
}

// Reads a value from the first header alias that is present.
export function pick(row, aliases) {
  for (const a of aliases) {
    const key = normalizeHeader(a);
    if (row[key] !== undefined && row[key] !== '') return row[key];
  }
  return '';
}

// "₦1,234.50" → 1234.5. Returns null when there is no number at all, so a
// caller can tell "absent" from "zero".
export function parseMoney(raw) {
  const s = String(raw ?? '').replace(/[^0-9.\-]/g, '');
  if (!s || s === '-' || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
