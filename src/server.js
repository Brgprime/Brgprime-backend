import { createApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './config/prisma.js';

async function start() {
  // Verify DB connectivity before accepting traffic.
  try {
    await prisma.$connect();
  } catch (err) {
    console.error('❌  Could not connect to the database. Did you run `npm run setup`?');
    console.error(err.message);
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(`\n🏠  BRG Prime API running`);
    console.log(`    → http://localhost:${env.port}`);
    console.log(`    → env: ${env.nodeEnv}\n`);
  });

  const shutdown = async (signal) => {
    console.log(`\n${signal} received — shutting down gracefully…`);
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start();
