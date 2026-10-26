// npm run seed (R5, R7-R9): creates exactly the brief's section 2 data on a freshly reset database.
// D20: auth users come from the Admin API, reference rows (orgs, memberships, tenants, units) from Prisma,
// and every lease and payment goes through the same services the HTTP API uses, so invoices and
// allocations are exactly what the app itself would produce.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { config as loadDotenv } from 'dotenv'

// D21: .env.local (the graders' file) first, .env as fallback. Must run before the app modules load,
// because src/lib/prisma.ts reads DATABASE_URL at import time, hence the dynamic imports in main().
loadDotenv({ path: ['.env.local', '.env'], quiet: true })

const SLIP_BUCKET = 'payment-slips'
const SLIP_FILE = path.join(__dirname, 'assets', 'slip-sample.pdf')

type OrgKey = 'northwind' | 'beta'
type Account = { email: string; org: OrgKey; role: 'manager' | 'staff' } | { email: string; org: OrgKey; tenantName: string }

const ACCOUNTS: Account[] = [
  { email: 'manager@northwind.test', org: 'northwind', role: 'manager' },
  { email: 'staff@northwind.test', org: 'northwind', role: 'staff' },
  { email: 'aisyah@northwind.test', org: 'northwind', tenantName: 'Aisyah Rahman' },
  { email: 'ben@northwind.test', org: 'northwind', tenantName: 'Ben Lim' },
  { email: 'probe@northwind.test', org: 'northwind', tenantName: 'Probe Tenant' },
  { email: 'manager@beta.test', org: 'beta', role: 'manager' },
  { email: 'chen@beta.test', org: 'beta', tenantName: 'Chen Wei' },
]

const ORG_NAMES: Record<OrgKey, string> = { northwind: 'Northwind Properties', beta: 'Beta Realty' }
const UNITS: { org: OrgKey; name: string }[] = [
  { org: 'northwind', name: 'A-12-3' },
  { org: 'northwind', name: 'B-05-1' },
  { org: 'northwind', name: 'C-01-7' },
  { org: 'northwind', name: 'D-03-2' },
  { org: 'beta', name: 'KL-1' },
]

// R8: amounts are the brief's ringgit figures in sen; D-03-2 has no lease.
const LEASES = [
  { unit: 'A-12-3', tenant: 'aisyah@northwind.test', by: 'manager@northwind.test', startDate: '2026-01-31', endDate: '2026-07-15', monthlyRentSen: 150000, depositSen: 300000 },
  { unit: 'B-05-1', tenant: 'ben@northwind.test', by: 'manager@northwind.test', startDate: '2026-01-01', endDate: '2026-04-15', monthlyRentSen: 100029, depositSen: 0 },
  { unit: 'C-01-7', tenant: 'probe@northwind.test', by: 'manager@northwind.test', startDate: '2026-02-28', endDate: '2027-02-27', monthlyRentSen: 200000, depositSen: 400000 },
  { unit: 'KL-1', tenant: 'chen@beta.test', by: 'manager@beta.test', startDate: '2026-03-15', endDate: '2027-03-14', monthlyRentSen: 220000, depositSen: 440000 },
] as const

class SeedError extends Error {}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new SeedError(`Seed bug: missing ${what}`)
  return v
}

async function main(): Promise<void> {
  const { prisma } = await import('@/lib/prisma')
  const { createAdminClient } = await import('@/lib/supabase/admin-client')
  const { createLease } = await import('@/server/services/leases')
  const { recordPayment, approvePayment } = await import('@/server/services/payments')

  try {
    if ((await prisma.organizations.count()) > 0) {
      throw new SeedError('Database is not fresh: run npx supabase db reset first')
    }

    // D24: one shared password for every seeded account.
    const password = process.env.SEED_PASSWORD || 'RentDemo#2026'
    const admin = createAdminClient()

    const userIds = new Map<string, string>()
    for (const a of ACCOUNTS) {
      const { data, error } = await admin.auth.admin.createUser({ email: a.email, password, email_confirm: true })
      if (error || !data.user) throw new SeedError(`Could not create auth user ${a.email}: ${error?.message ?? 'no user returned'}`)
      userIds.set(a.email, data.user.id)
    }

    const orgIds = new Map<OrgKey, string>()
    for (const key of ['northwind', 'beta'] as const) {
      const org = await prisma.organizations.create({ data: { name: ORG_NAMES[key] }, select: { id: true } })
      orgIds.set(key, org.id)
    }

    // R37: roles live in memberships (staff/manager) and tenants.user_id (tenants); never user_metadata.
    const tenantIds = new Map<string, string>()
    for (const a of ACCOUNTS) {
      const orgId = need(orgIds.get(a.org), `org ${a.org}`)
      const userId = need(userIds.get(a.email), `user ${a.email}`)
      if ('role' in a) {
        await prisma.memberships.create({ data: { user_id: userId, org_id: orgId, role: a.role } })
      } else {
        const t = await prisma.tenants.create({
          data: { org_id: orgId, user_id: userId, full_name: a.tenantName, email: a.email },
          select: { id: true },
        })
        tenantIds.set(a.email, t.id)
      }
    }

    const unitIds = new Map<string, string>()
    for (const u of UNITS) {
      const row = await prisma.units.create({
        data: { org_id: need(orgIds.get(u.org), `org ${u.org}`), name: u.name },
        select: { id: true },
      })
      unitIds.set(u.name, row.id)
    }

    // R5/R46: leases and their invoices only through createLease (generateSchedule + audit row).
    const leaseIds = new Map<string, string>()
    for (const l of LEASES) {
      const { id } = await createLease(
        { userId: need(userIds.get(l.by), `user ${l.by}`) },
        {
          unitId: need(unitIds.get(l.unit), `unit ${l.unit}`),
          tenantId: need(tenantIds.get(l.tenant), `tenant ${l.tenant}`),
          startDate: l.startDate,
          endDate: l.endDate,
          monthlyRentSen: l.monthlyRentSen,
          depositSen: l.depositSen,
        },
      )
      leaseIds.set(l.unit, id)
    }

    // R9: Aisyah's two payments, through recordPayment / approvePayment (cap, allocation, audit).
    const northwindId = need(orgIds.get('northwind'), 'org northwind')
    const aisyahLeaseId = need(leaseIds.get('A-12-3'), 'lease A-12-3')
    const managerCtx = { userId: need(userIds.get('manager@northwind.test'), 'northwind manager') }
    const staffCtx = { userId: need(userIds.get('staff@northwind.test'), 'northwind staff') }

    const cash = await recordPayment(managerCtx, aisyahLeaseId, {
      amountSen: 300000,
      method: 'cash',
      receivedAt: '2026-01-31T10:00:00+08:00',
    })
    if (cash.status !== 'approved') throw new SeedError(`Cash payment status is ${cash.status}, expected approved`)

    // R44/D22: the slip lives at <org_id>/<lease_id>/<uuid>.pdf, uploaded before recording like the UI does.
    const slipPath = `${northwindId}/${aisyahLeaseId}/${randomUUID()}.pdf`
    const upload = await admin.storage
      .from(SLIP_BUCKET)
      .upload(slipPath, readFileSync(SLIP_FILE), { contentType: 'application/pdf', upsert: false })
    if (upload.error) throw new SeedError(`Could not upload the sample slip: ${upload.error.message}`)

    const transfer = await recordPayment(staffCtx, aisyahLeaseId, {
      amountSen: 200000,
      method: 'bank_transfer',
      receivedAt: '2026-03-01T00:30:00+08:00',
      slipPath,
    })
    if (transfer.status !== 'pending_verification') {
      throw new SeedError(`Bank transfer status is ${transfer.status}, expected pending_verification`)
    }
    const approved = await approvePayment(managerCtx, transfer.id)
    if (approved.status !== 'approved') throw new SeedError(`Approval returned ${approved.status}`)

    const [invoiceCount, allocationCount] = await Promise.all([prisma.invoices.count(), prisma.payment_allocations.count()])
    console.log('Seed complete.')
    console.log(`  Organizations: ${ORG_NAMES.northwind} (${northwindId}), ${ORG_NAMES.beta} (${need(orgIds.get('beta'), 'org beta')})`)
    console.log(`  Accounts (${ACCOUNTS.length}, shared password from SEED_PASSWORD): ${ACCOUNTS.map((a) => a.email).join(', ')}`)
    for (const l of LEASES) console.log(`  Lease ${l.unit}: ${need(leaseIds.get(l.unit), `lease ${l.unit}`)}`)
    console.log(`  Invoices: ${invoiceCount}, allocations: ${allocationCount}`)
    console.log(`  Aisyah payments: cash ${cash.id} (approved), bank transfer ${transfer.id} (approved, slip uploaded)`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e: unknown) => {
  // Only the message: never env values, tokens or whole error objects (they can carry connection strings).
  const status = typeof e === 'object' && e !== null && 'status' in e && typeof e.status === 'number' ? ` (HTTP ${e.status})` : ''
  console.error(`Seed failed${status}: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
