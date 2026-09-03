import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const DOC = 'cmtlr4mux000d28tykussn1ai'; // ADMIN BUILDING STRUCTURAL.pdf, 1.3 MB

for (let i = 0; i < 6; i++) {
  try { await p.$queryRaw`SELECT 1`; break; }
  catch { console.log('waking Neon...'); await new Promise(r => setTimeout(r, 4000)); }
}
await fetch('https://brgprime.com/api/buildq/').catch(() => {});

const doc = await p.buildqDocument.findUnique({ where: { id: DOC }, select: { name: true } });
const job = await p.buildqAnalysisJob.create({ data: { documentId: DOC, status: 'queued' }, select: { id: true } });
console.log(`${doc.name} → job ${job.id}\n`);

const t0 = Date.now();
let last = '';
while (Date.now() - t0 < 420000) {
  await new Promise(r => setTimeout(r, 5000));
  const j = await p.buildqAnalysisJob.findUnique({
    where: { id: job.id },
    select: { status: true, attempts: true, error: true, result: true },
  });
  const line = `${((Date.now()-t0)/1000).toFixed(0)}s  ${j.status} att=${j.attempts}`;
  if (line !== last) { console.log(line); last = line; }
  if (j.status === 'succeeded' || j.status === 'failed') {
    console.log(`\n=== ${j.status.toUpperCase()} in ${((Date.now()-t0)/1000).toFixed(0)}s ===`);
    if (j.error) console.log('error:', j.error);
    if (j.result) {
      const r = j.result;
      console.log('model      :', r.model);
      console.log('tokens     :', JSON.stringify(r.usage));
      console.log('sheet      :', r.sheetType, '/', r.discipline, '/ scale', r.scale, `(${r.scaleBasis})`);
      console.log('pages      :', r.pages);
      console.log(`elements   : ${(r.elements||[]).length}`);
      for (const e of (r.elements||[]).slice(0, 10))
        console.log(`   ${e.type} — count=${e.count} len=${e.length} area=${e.area} vol=${e.volume} ${e.unit||''} [${e.basis}] conf=${e.confidence}`);
      console.log(`measurements: ${(r.measurements||[]).length}`);
      for (const m of (r.measurements||[]).slice(0, 15))
        console.log(`   ${m.name} = ${m.value} ${m.unit} [${m.basis}] conf=${m.confidence}${m.conventionClash ? '  <-- CLASH' : ''}`);
      console.log('warnings   :', JSON.stringify(r.warnings, null, 1));
    }
    break;
  }
}
await p.$disconnect();
