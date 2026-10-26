import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@/generated/prisma/client'

// D18: Prisma connects as the database owner (bypasses RLS); every service checks role and scopes by org.
// The dev-mode cache (one pool across HMR reloads) is keyed to the generated client class, so a
// `prisma generate` while `next dev` runs replaces the stale instance instead of serving old models.
const g = globalThis as unknown as { prisma?: PrismaClient; prismaClass?: typeof PrismaClient }

function create(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })
}

const cached = g.prismaClass === PrismaClient ? g.prisma : undefined
if (!cached && g.prisma) void g.prisma.$disconnect().catch(() => undefined)

export const prisma = cached ?? create()

if (process.env.NODE_ENV !== 'production') {
  g.prisma = prisma
  g.prismaClass = PrismaClient
}
