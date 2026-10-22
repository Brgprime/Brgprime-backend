// Remove test payment data: every transaction and subscription-history row,
// and move users on a paid plan back to Free (no real payment has been made).
// Dry run by default — prints what would change. Pass --apply to commit.
//
//   node scripts/wipe-test-payments.js
//   node scripts/wipe-test-payments.js --apply
import { prisma } from '../src/config/prisma.js';

const apply = process.argv.includes('--apply');

const [transactions, history, paidUsers] = await Promise.all([
  prisma.transaction.findMany({ orderBy: { createdAt: 'asc' } }),
  prisma.subscriptionHistory.count(),
  prisma.user.findMany({
    where: { planId: { not: 'free' } },
    select: { id: true, name: true, email: true, planId: true },
  }),
]);

console.log(`Transactions (${transactions.length}):`);
transactions.forEach((t) =>
  console.log(`  ${t.createdAt.toISOString().slice(0, 10)}  ${t.customer || '-'}  ${t.plan}  ₦${t.amount.toLocaleString()}  ${t.status}`)
);
console.log(`Subscription history rows: ${history}`);
console.log(`Users on a paid plan (${paidUsers.length}):`);
paidUsers.forEach((u) => console.log(`  ${u.name} <${u.email}>  ${u.planId}`));

if (!apply) {
  console.log('\nDry run — nothing changed. Re-run with --apply to wipe.');
} else {
  const [tx, sh, us] = await prisma.$transaction([
    prisma.transaction.deleteMany({}),
    prisma.subscriptionHistory.deleteMany({}),
    prisma.user.updateMany({
      where: { planId: { not: 'free' } },
      data: { planId: 'free', premiumUsed: 0, boostsUsed: 0, renewsAt: null },
    }),
  ]);
  console.log(`\n✔ Deleted ${tx.count} transactions and ${sh.count} history rows; reset ${us.count} users to Free.`);
}

await prisma.$disconnect();
