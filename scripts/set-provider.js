// Switch the Prisma datasource provider between SQLite (local dev) and
// PostgreSQL (production / Neon) without hand-editing schema.prisma.
//
//   node scripts/set-provider.js postgresql
//   node scripts/set-provider.js sqlite
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, '..', 'prisma', 'schema.prisma');

const provider = process.argv[2];
if (!['sqlite', 'postgresql'].includes(provider)) {
  console.error('Usage: node scripts/set-provider.js <sqlite|postgresql>');
  process.exit(1);
}

let schema = readFileSync(schemaPath, 'utf8');
const before = schema;
schema = schema.replace(/provider\s*=\s*"(sqlite|postgresql)"/, `provider = "${provider}"`);

if (schema === before) {
  console.error('Could not find the datasource provider line to update.');
  process.exit(1);
}

writeFileSync(schemaPath, schema);
console.log(`✔ Prisma datasource provider set to "${provider}".`);
console.log('  Next: update DATABASE_URL, then run your migrations.');
