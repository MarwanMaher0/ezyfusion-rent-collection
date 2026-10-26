"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { invoiceStatus, toMytDate, type InvoiceStatus } from "@/lib/billing";
import { formatMytDisplay } from "@/lib/dates";
import { formatSen } from "@/lib/money";
import { cn } from "@/lib/utils";

export type LeaseView = {
  id: string;
  unitName: string;
  startDate: string;
  endDate: string;
  monthlyRentSen: number;
  depositSen: number;
};

export type InvoiceView = {
  id: string;
  leaseId: string;
  kind: "deposit" | "rent";
  periodIndex: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  dueDate: string;
  amountSen: number;
};

export type PaymentView = {
  id: string;
  leaseId: string;
  amountSen: number;
  unappliedSen: number;
  method: "cash" | "bank_transfer" | "online";
  status: "pending_verification" | "approved" | "rejected" | "voided";
  receivedAt: string;
};

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  paid: "Paid",
  partially_paid: "Partially paid",
  unpaid: "Unpaid",
  overdue: "Overdue",
};

const STATUS_BADGE: Record<InvoiceStatus, "default" | "secondary" | "destructive" | "outline"> = {
  paid: "default",
  partially_paid: "secondary",
  unpaid: "outline",
  overdue: "destructive",
};

const PAYMENT_STATUS_LABEL: Record<PaymentView["status"], string> = {
  pending_verification: "Pending verification",
  approved: "Approved",
  rejected: "Rejected",
  voided: "Voided",
};

const METHOD_LABEL: Record<PaymentView["method"], string> = {
  cash: "Cash",
  bank_transfer: "Bank transfer",
  online: "Online",
};

type CreatedBill = { billId: string; amountSen: number };

function describeInvoice(inv: InvoiceView): string {
  if (inv.kind === "deposit") return "Deposit";
  return `Rent, period ${(inv.periodIndex ?? 0) + 1}`;
}

export function LeaseSection({
  lease,
  invoices,
  payments,
  paidByInvoice,
  now,
}: {
  lease: LeaseView;
  invoices: InvoiceView[];
  payments: PaymentView[];
  paidByInvoice: Map<string, number>;
  // Client-only "now" (set after mount), so nothing time-dependent is rendered by the server (R52).
  now: Date;
}) {
  const [bill, setBill] = useState<CreatedBill | null>(null);
  const [creating, setCreating] = useState(false);

  const rows = invoices.map((inv) => {
    const paidSen = paidByInvoice.get(inv.id) ?? 0;
    return { inv, paidSen, status: invoiceStatus({ dueDate: inv.dueDate, amountSen: inv.amountSen, paidSen }, now) };
  });

  // R30 mirror: unpaid amounts of invoices due on or before today's Malaysia date. The server recomputes it.
  const today = toMytDate(now);
  const dueNowSen = rows.reduce(
    (sum, r) => (r.inv.dueDate <= today ? sum + Math.max(r.inv.amountSen - r.paidSen, 0) : sum),
    0,
  );

  async function payNow() {
    setCreating(true);
    try {
      const res = await fetch(`/api/leases/${lease.id}/gateway-bills`, { method: "POST" });
      const body: unknown = await res.json().catch(() => null);
      if (res.status === 201 && isCreatedBill(body)) {
        setBill(body);
        toast.success("Payment bill created");
      } else if (res.status === 422) {
        toast.error("Nothing is due");
      } else {
        toast.error(errorMessage(body) ?? "Could not create the payment bill");
      }
    } catch {
      toast.error("Could not reach the server");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Unit {lease.unitName}</CardTitle>
        <CardDescription>
          Lease {lease.startDate} to {lease.endDate} · Rent {formatSen(lease.monthlyRentSen)} per month · Deposit{" "}
          {formatSen(lease.depositSen)}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
          <div>
            <p className="text-sm text-muted-foreground">Amount due now</p>
            <p className="text-2xl font-semibold" data-testid="amount-due-now">
              {formatSen(dueNowSen)}
            </p>
            {dueNowSen === 0 && (
              <p className="text-sm text-muted-foreground">Nothing is due right now.</p>
            )}
          </div>
          <Button onClick={payNow} disabled={dueNowSen === 0 || creating}>
            {creating ? "Creating bill..." : "Pay now"}
          </Button>
        </div>

        {bill && (
          <Card size="sm" className="border-primary/40">
            <CardHeader>
              <CardTitle>Payment bill created</CardTitle>
              <CardDescription>
                The bill is settled only when the gateway confirms it. Paying here does not change anything by itself.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                <dt className="text-muted-foreground">Bill id</dt>
                <dd className="font-mono break-all" data-testid="bill-id">
                  {bill.billId}
                </dd>
                <dt className="text-muted-foreground">Amount</dt>
                <dd>{formatSen(bill.amountSen)}</dd>
              </dl>
              <div>
                <p className="mb-1 text-muted-foreground">Simulate the gateway callback:</p>
                <code className="block rounded-md bg-muted px-3 py-2 font-mono text-xs break-all select-all">
                  node gateway-sim.mjs {bill.billId} {bill.amountSen} true
                </code>
              </div>
              <Link
                href={`/payments/return?bill_id=${bill.billId}&paid=true`}
                className={cn(buttonVariants({ variant: "outline" }), "w-fit")}
              >
                Go to the return page
              </Link>
            </CardContent>
          </Card>
        )}

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Invoices</h3>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No invoices yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ inv, paidSen, status }) => (
                  <TableRow key={inv.id}>
                    <TableCell>{describeInvoice(inv)}</TableCell>
                    <TableCell>
                      {inv.periodStart && inv.periodEnd ? `${inv.periodStart} to ${inv.periodEnd}` : "-"}
                    </TableCell>
                    <TableCell>{inv.dueDate}</TableCell>
                    <TableCell className="text-right">{formatSen(inv.amountSen)}</TableCell>
                    <TableCell className="text-right">{formatSen(paidSen)}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_BADGE[status]}>{STATUS_LABEL[status]}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Payments</h3>
          {payments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No payments yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Received (Malaysia time)</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payments.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{formatMytDisplay(new Date(p.receivedAt))}</TableCell>
                    <TableCell>{METHOD_LABEL[p.method]}</TableCell>
                    <TableCell className="text-right">{formatSen(p.amountSen)}</TableCell>
                    <TableCell>
                      <Badge variant={p.status === "approved" ? "default" : p.status === "pending_verification" ? "secondary" : "outline"}>
                        {PAYMENT_STATUS_LABEL[p.status]}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      </CardContent>
    </Card>
  );
}

function isCreatedBill(v: unknown): v is CreatedBill {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.billId === "string" && typeof o.amountSen === "number" && Number.isSafeInteger(o.amountSen);
}

function errorMessage(v: unknown): string | null {
  if (typeof v !== "object" || v === null) return null;
  const e = (v as Record<string, unknown>).error;
  return typeof e === "string" ? e : null;
}
