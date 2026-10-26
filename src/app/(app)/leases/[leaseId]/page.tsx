import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PaymentActions } from "@/components/staff/payment-actions";
import { RecordPaymentForm } from "@/components/staff/record-payment-form";
import { StaffNav } from "@/components/staff/staff-nav";
import { ViewSlipButton } from "@/components/staff/view-slip-button";
import {
  InvoiceStatusBadge,
  methodLabel,
  PaymentStatusBadge,
} from "@/components/staff/labels";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatInstantMyt, formatMytDisplay, parseInstantWithOffset } from "@/lib/dates";
import { ApiError } from "@/lib/errors";
import { formatSen } from "@/lib/money";
import { loadCaller } from "@/server/access";
import { getUserId } from "@/server/auth";
import { getLease, listLeases } from "@/server/services/leases";

export default async function LeasePage({ params }: { params: Promise<{ leaseId: string }> }) {
  const { leaseId } = await params;
  const userId = await getUserId();
  if (!userId) redirect("/login");

  const caller = await loadCaller(userId);
  // UX redirect only: getLease and every mutation route authorize again (R36).
  if (!caller.member) {
    if (caller.tenantIds.length > 0) redirect("/tenant");
    redirect("/");
  }

  const ctx = { userId };
  let detail: Awaited<ReturnType<typeof getLease>>;
  try {
    detail = await getLease(ctx, leaseId);
  } catch (e) {
    // Other org, other tenant, nonexistent or malformed id all look the same (R38).
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) notFound();
    throw e;
  }
  const { lease, invoices, payments } = detail;
  const summary = (await listLeases(ctx)).find((l) => l.id === lease.id);

  const isManager = caller.member.role === "manager";
  // A lease the caller can open belongs to the caller's org, so that org is the slip folder (R44).
  const orgId = caller.member.orgId;
  const totalSen = invoices.reduce((s, i) => s + i.amountSen, 0);
  const paidSen = invoices.reduce((s, i) => s + i.paidSen, 0);

  return (
    <>
      <StaffNav active="/leases" />
      <div className="mb-6">
        <Link href="/leases" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          Back to leases
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {summary ? `${summary.unitName} - ${summary.tenantName}` : "Lease"}
        </h1>
        <p className="text-sm text-muted-foreground tabular-nums">
          {lease.startDate} to {lease.endDate}, rent {formatSen(lease.monthlyRentSen)} a month, deposit{" "}
          {formatSen(lease.depositSen)}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card size="sm">
          <CardHeader>
            <CardDescription>Invoiced</CardDescription>
            <CardTitle className="tabular-nums">{formatSen(totalSen)}</CardTitle>
          </CardHeader>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription>Paid</CardDescription>
            <CardTitle className="tabular-nums">{formatSen(paidSen)}</CardTitle>
          </CardHeader>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription>Outstanding</CardDescription>
            <CardTitle className="tabular-nums">{formatSen(totalSen - paidSen)}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Invoices</CardTitle>
          <CardDescription>In the order payments are allocated.</CardDescription>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              This lease has no invoices.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead>Due date</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="tabular-nums">
                      {inv.kind === "deposit" ? "Deposit" : `${inv.periodStart} – ${inv.periodEnd}`}
                    </TableCell>
                    <TableCell className="tabular-nums">{inv.dueDate}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatSen(inv.amountSen)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatSen(inv.paidSen)}</TableCell>
                    <TableCell>
                      <InvoiceStatusBadge status={inv.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Payments</CardTitle>
          <CardDescription>Times are shown in Malaysia time.</CardDescription>
        </CardHeader>
        <CardContent>
          {payments.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No payments yet. Record the first one below.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Received at (Malaysia time)</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Unapplied</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payments.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="tabular-nums">
                      {formatMytDisplay(parseInstantWithOffset(p.receivedAt))}
                    </TableCell>
                    <TableCell>{methodLabel(p.method)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatSen(p.amountSen)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatSen(p.unappliedSen)}</TableCell>
                    <TableCell>
                      <PaymentStatusBadge status={p.status} />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {p.method === "bank_transfer" && <ViewSlipButton paymentId={p.id} />}
                        {isManager && (
                          <PaymentActions
                            paymentId={p.id}
                            status={p.status}
                            amountLabel={formatSen(p.amountSen)}
                          />
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Record a payment</CardTitle>
          <CardDescription>Cash or bank transfer received for this lease.</CardDescription>
        </CardHeader>
        <CardContent>
          <RecordPaymentForm
            leaseId={lease.id}
            orgId={orgId}
            isManager={isManager}
            defaultReceivedAt={formatInstantMyt(new Date()).slice(0, 16)}
          />
        </CardContent>
      </Card>
    </>
  );
}
