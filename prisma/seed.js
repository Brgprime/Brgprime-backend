// Seed the database from the same mock data the frontend ships with, so the
// API returns identical content to what the web/mobile apps expect.
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { mockProperties, mockForumMessages, mockNotifications } from './seed-data/mockData.js';

const prisma = new PrismaClient();

const DEMO_PASSWORD = 'password123'; // used for every seeded account (dev only)

// Distinct agent display names in the mock data → seeded "seller" users.
const AGENTS = [
  'Sarah Williams',
  'Emeka Johnson',
  'Amara Peters',
  'Prime Properties',
  'Lagos Homes Realty',
  'Chioma Obi',
];

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/(^\.|\.$)/g, '');
}

async function main() {
  console.log('🌱  Seeding BRG Prime database…');

  // Wipe (idempotent re-seed) — order respects FK constraints.
  await prisma.viewing.deleteMany();
  await prisma.favorite.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.forumMessage.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.subscriptionHistory.deleteMany();
  await prisma.property.deleteMany();
  await prisma.user.deleteMany();

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  // ── Demo primary user (matches the frontend default identity) ────────────
  const demo = await prisma.user.create({
    data: {
      name: 'Tunde Adeyemi',
      email: 'tunde@example.com',
      passwordHash,
      phone: '08012345678',
      bio: 'Real estate enthusiast based in Nigeria.',
      avatarUrl: 'https://i.pravatar.cc/150?u=brgprime',
      emailVerified: true,
      planId: 'free',
    },
  });

  // ── Admin user ───────────────────────────────────────────────────────────
  await prisma.user.create({
    data: {
      name: 'BRG Admin',
      email: 'admin@brgprime.ng',
      passwordHash,
      phone: '08000000000',
      role: 'admin',
      emailVerified: true,
      avatarUrl: 'https://i.pravatar.cc/150?u=admin',
    },
  });

  // ── Agent users (owners of the seeded listings) ──────────────────────────
  const agentByName = {};
  for (const name of AGENTS) {
    const user = await prisma.user.create({
      data: {
        name,
        email: `${slug(name)}@brgprime.ng`,
        passwordHash,
        phone: '0801' + Math.floor(1000000 + Math.random() * 8999999),
        avatarUrl: `https://api.dicebear.com/7.x/avataaars/png?seed=${slug(name).split('.')[0]}`,
        emailVerified: true,
        planId: 'silver',
        renewsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    agentByName[name] = user;
  }

  // ── Properties ───────────────────────────────────────────────────────────
  // Preserve the mock ids ('1'..'33') so any hard-coded references still work.
  let verifiedPending = 0;
  for (const p of mockProperties) {
    const owner = agentByName[p.agentName] || null;
    // Give the admin panel a realistic spread of statuses.
    let adminStatus = 'Active';
    if (!p.isVerified && verifiedPending < 3) {
      adminStatus = 'Pending';
      verifiedPending++;
    }
    await prisma.property.create({
      data: {
        id: p.id,
        title: p.title,
        address: p.address,
        description: p.description,
        price: p.price,
        listingType: p.listingType,
        propertyType: p.propertyType,
        bedrooms: p.bedrooms ?? 0,
        bathrooms: p.bathrooms ?? 0,
        size: p.size ?? 0,
        yearBuilt: p.yearBuilt ?? null,
        furnishingStatus: p.furnishingStatus ?? 'Unfurnished',
        propertyCondition: p.propertyCondition ?? 'Good',
        amenities: JSON.stringify(p.amenities ?? []),
        images: JSON.stringify(p.images ?? []),
        isRecentlyPosted: !!p.isRecentlyPosted,
        isVerified: !!p.isVerified,
        isPremium: false,
        isBoosted: false,
        agentName: p.agentName,
        agentAvatar: p.agentAvatar,
        rating: p.rating ?? 0,
        reviewCount: p.reviewCount ?? 0,
        status: 'Active',
        adminStatus,
        views: Math.floor(200 + Math.random() * 4000),
        saves: Math.floor(5 + Math.random() * 300),
        ownerId: owner ? owner.id : null,
        createdAt: p.createdAt ? new Date(p.createdAt) : new Date(),
      },
    });
  }
  console.log(`   • ${mockProperties.length} properties`);

  // ── Forum messages (seed the group chat) ─────────────────────────────────
  // "Me" messages belong to the demo user.
  let t = Date.now() - mockForumMessages.length * 60000;
  for (const m of mockForumMessages) {
    const isMe = m.isMe;
    const author = isMe ? demo : agentByName[m.sender] || null;
    await prisma.forumMessage.create({
      data: {
        userId: author ? author.id : null,
        sender: isMe ? demo.name : m.sender,
        text: m.text,
        avatar: isMe ? demo.avatarUrl : m.avatar,
        createdAt: new Date(t),
      },
    });
    t += 60000;
  }
  console.log(`   • ${mockForumMessages.length} forum messages`);

  // ── Notifications for the demo user ──────────────────────────────────────
  const nowMs = Date.now();
  const offsets = [2 * 60000, 3600000, 3 * 3600000, 5 * 3600000, 86400000, 2 * 86400000];
  for (let i = 0; i < mockNotifications.length; i++) {
    const n = mockNotifications[i];
    await prisma.notification.create({
      data: {
        userId: demo.id,
        title: n.title,
        message: n.message,
        type: n.type,
        read: n.read,
        createdAt: new Date(nowMs - (offsets[i] ?? (i + 1) * 3600000)),
      },
    });
  }
  console.log(`   • ${mockNotifications.length} notifications`);

  // ── Payments ledger (PaymentsView seeded rows) ───────────────────────────
  const payments = [
    { tenantName: 'Adebayo Okafor', property: 'Modern Luxury Apartment, Lekki', amount: 2500000, status: 'Paid' },
    { tenantName: 'Ngozi Eze', property: 'Studio Apartment, Yaba', amount: 800000, status: 'Paid' },
    { tenantName: 'Emeka Nwachukwu', property: '3-Bedroom Terrace, Gbagada', amount: 1800000, status: 'Overdue' },
  ];
  for (const pay of payments) {
    await prisma.payment.create({ data: { ...pay, userId: demo.id } });
  }
  console.log(`   • ${payments.length} payments`);

  // ── Transactions (admin revenue) ─────────────────────────────────────────
  const txns = [
    { customer: 'Sarah Williams', plan: 'Gold Plan', amount: 64000, status: 'Successful' },
    { customer: 'Emeka Johnson', plan: 'Bronze Plan', amount: 40000, status: 'Successful' },
    { customer: 'Amara Peters', plan: 'Silver Plan', amount: 18000, status: 'Successful' },
    { customer: 'Prime Properties', plan: 'Gold Plan', amount: 64000, status: 'Successful' },
    { customer: 'Lagos Homes Realty', plan: 'Bronze Plan', amount: 40000, status: 'Pending' },
    { customer: 'Chioma Obi', plan: 'Silver Plan', amount: 18000, status: 'Successful' },
  ];
  for (let i = 0; i < txns.length; i++) {
    await prisma.transaction.create({
      data: {
        ...txns[i],
        reference: `BRG-SEED-${1000 + i}`,
        createdAt: new Date(nowMs - i * 6 * 3600000),
      },
    });
  }
  console.log(`   • ${txns.length} transactions`);

  // A couple of saved favorites for the demo user.
  for (const id of ['1', '7']) {
    await prisma.favorite.create({ data: { userId: demo.id, propertyId: id } });
  }

  console.log('✅  Seed complete.');
  console.log('   Demo login    → tunde@example.com / ' + DEMO_PASSWORD);
  console.log('   Admin login   → admin@brgprime.ng / ' + DEMO_PASSWORD);
}

main()
  .catch((e) => {
    console.error('❌  Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
