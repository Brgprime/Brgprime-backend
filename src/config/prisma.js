import { PrismaClient } from '@prisma/client';
import { env } from './env.js';

// Single shared Prisma client instance across the app.
export const prisma = new PrismaClient({
  log: env.isProd ? ['error'] : ['warn', 'error'],
});
