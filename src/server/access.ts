import type { leases, payments } from '@/generated/prisma/client'
import { forbidden, notFound } from '@/lib/errors'
import { prisma } from '@/lib/prisma'

export type MemberRole = 'manager' | 'staff'
export type AccessRole = MemberRole | 'tenant'

export type Caller = {
  userId: string
  member: { orgId: string; role: MemberRole } | null
  tenantIds: string[]
}

// Shape check only; a well-formed id that does not exist is still a 404 after the lookup (R38).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

function isMemberRole(role: string): role is MemberRole {
  return role === 'manager' || role === 'staff'
}

// R37/D17: roles come only from memberships (staff/manager, one org per user) and tenants.user_id;
// never from user_metadata or anything else the user can edit.
export async function loadCaller(userId: string): Promise<Caller> {
  const [membership, tenantRows] = await Promise.all([
    prisma.memberships.findUnique({ where: { user_id: userId }, select: { org_id: true, role: true } }),
    prisma.tenants.findMany({ where: { user_id: userId }, select: { id: true } }),
  ])
  const member = membership && isMemberRole(membership.role) ? { orgId: membership.org_id, role: membership.role } : null
  return { userId, member, tenantIds: tenantRows.map((t) => t.id) }
}

// For endpoints with no target record (POST /api/leases, reports): not a listed member role -> 403.
export function requireMember(caller: Caller, roles: MemberRole[]): { orgId: string; role: MemberRole } {
  if (!caller.member || !roles.includes(caller.member.role)) throw forbidden()
  return caller.member
}

// The roles under which the caller can see a lease: member of its org, and/or its tenant.
export function rolesOnLease(caller: Caller, lease: { org_id: string; tenant_id: string }): AccessRole[] {
  const result: AccessRole[] = []
  if (caller.member && caller.member.orgId === lease.org_id) result.push(caller.member.role)
  if (caller.tenantIds.includes(lease.tenant_id)) result.push('tenant')
  return result
}

// R38 order: not visible (malformed id, nonexistent, other org, other tenant's lease) -> 404 first,
// so existence is never revealed; visible but no allowed role -> 403.
function checkLease(caller: Caller, lease: leases | null, roles: AccessRole[], what: string): leases {
  if (!lease) throw notFound(`${what} not found`)
  const visibleAs = rolesOnLease(caller, lease)
  if (visibleAs.length === 0) throw notFound(`${what} not found`)
  if (!visibleAs.some((r) => roles.includes(r))) throw forbidden()
  return lease
}

export async function requireLeaseAccess(caller: Caller, leaseId: string, roles: AccessRole[]): Promise<leases> {
  if (!isUuid(leaseId)) throw notFound('Lease not found')
  const lease = await prisma.leases.findUnique({ where: { id: leaseId } })
  return checkLease(caller, lease, roles, 'Lease')
}

export async function requirePaymentAccess(caller: Caller, paymentId: string, roles: AccessRole[]): Promise<payments> {
  if (!isUuid(paymentId)) throw notFound('Payment not found')
  const payment = await prisma.payments.findUnique({ where: { id: paymentId } })
  if (!payment) throw notFound('Payment not found')
  // Scoped by the payment's own org_id, so a mismatched row can never widen visibility.
  const lease = await prisma.leases.findFirst({ where: { id: payment.lease_id, org_id: payment.org_id } })
  checkLease(caller, lease, roles, 'Payment')
  return payment
}
