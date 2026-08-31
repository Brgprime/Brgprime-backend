// ─────────────────────────────────────────────────────────────────────────────
// Serialization helpers.
//
// Money that can exceed ~2.1bn naira is stored as BigInt, which JSON.stringify
// throws on. Everything leaving the API goes through `plain()` so the frontend
// receives ordinary numbers, matching its "naira as integers" contract.
// ─────────────────────────────────────────────────────────────────────────────

// Recursively convert BigInt → Number and Date → ISO string.
export function plain(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object') {
    // Leave Prisma Decimal / Buffer style objects alone.
    if (Buffer.isBuffer(value)) return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = plain(v);
    return out;
  }
  return value;
}

// Strip fields that must never leave the server.
const USER_SECRETS = ['passwordHash', 'resetTokenHash', 'resetExpiresAt', 'tokenVersion'];

export function publicUser(user) {
  if (!user) return null;
  const out = plain(user);
  for (const key of USER_SECRETS) delete out[key];
  return out;
}

export function publicOrg(org) {
  if (!org) return null;
  return plain({
    id: org.id,
    name: org.name,
    industry: org.industry,
    country: org.country,
    currency: org.currency,
    createdAt: org.createdAt,
  });
}
