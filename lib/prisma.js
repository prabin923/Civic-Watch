import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

function createPrismaClient(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is required to initialize Prisma.');
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
}

const globalForPrisma = globalThis;

export const prisma = globalForPrisma.civicwatchPrisma || createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.civicwatchPrisma = prisma;

export { createPrismaClient };
