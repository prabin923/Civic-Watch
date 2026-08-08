import { prisma } from '../lib/prisma.js';
import { resetAndSeed } from '../lib/platform.js';

await resetAndSeed(prisma);
await prisma.$disconnect();
console.log('CivicWatch Prisma database seeded.');
