"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/browser";
import { LeaseSection, type InvoiceView, type LeaseView, type PaymentView } from "./lease-section";
import { PhoneForm } from "./phone-form";

// Money columns are bigint in Postgres; PostgREST sends them as JSON numbers, validated as safe integers here.
const sen = z.number().int().safe();
const tenantRow = z.object({
  id: z.string(),
  full_name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
});
const leaseRow = z.object({
  id: z.string(),
  unit_id: z.string(),
  start_date: z.string(),
  end_date: z.string(),
  monthly_rent_sen: sen,
  deposit_sen: sen,
});
const unitRow = z.object({ id: z.string(), name: z.string() });
const invoiceRow = z.object({
  id: z.string(),
  lease_id: z.string(),
  kind: z.enum(["deposit", "rent"]),
  period_index: z.number().int().nullable(),
  period_start: z.string().nullable(),
  period_end: z.string().nullable(),
  due_date: z.string(),
  amount_sen: sen,
});
const allocationRow = z.object({ invoice_id: z.string(), amount_sen: sen });
const paymentRow = z.object({
  id: z.string(),
  lease_id: z.string(),
  amount_sen: sen,
  unapplied_sen: sen,
  method: z.enum(["cash", "bank_transfer", "online"]),
  status: z.enum(["pending_verification", "approved", "rejected", "voided"]),
  received_at: z.string(),
});

type Tenant = z.infer<typeof tenantRow>;
type Data = {
  tenants: Tenant[];
  leases: LeaseView[];
  invoices: InvoiceView[];
  payments: PaymentView[];
  paidByInvoice: Map<string, number>;
};

async function loadData(): Promise<Data> {
  const supabase = createClient();
  // RLS (R42) limits every table to the signed-in tenant's own rows; no filter is needed or trusted here.
  const [tenants, leases, units, invoices, allocations, payments] = await Promise.all([
    supabase.from("tenants").select("id, full_name, email, phone").order("full_name"),
    supabase
      .from("leases")
      .select("id, unit_id, start_date, end_date, monthly_rent_sen, deposit_sen")
      .order("start_date", { ascending: false }),
    supabase.from("units").select("id, name"),
    supabase
      .from("invoices")
      .select("id, lease_id, kind, period_index, period_start, period_end, due_date, amount_sen")
      .order("due_date")
      .order("period_index", { nullsFirst: true }),
    supabase.from("payment_allocations").select("invoice_id, amount_sen"),
    supabase
      .from("payments")
      .select("id, lease_id, amount_sen, unapplied_sen, method, status, received_at")
      .order("received_at", { ascending: false }),
  ]);
  for (const r of [tenants, leases, units, invoices, allocations, payments]) {
    if (r.error) throw new Error(r.error.message);
  }
  const unitName = new Map(z.array(unitRow).parse(units.data).map((u) => [u.id, u.name]));
  const paidByInvoice = new Map<string, number>();
  for (const a of z.array(allocationRow).parse(allocations.data)) {
    paidByInvoice.set(a.invoice_id, (paidByInvoice.get(a.invoice_id) ?? 0) + a.amount_sen);
  }
  return {
    tenants: z.array(tenantRow).parse(tenants.data),
    leases: z.array(leaseRow).parse(leases.data).map((l) => ({
      id: l.id,
      unitName: unitName.get(l.unit_id) ?? "-",
      startDate: l.start_date,
      endDate: l.end_date,
      monthlyRentSen: l.monthly_rent_sen,
      depositSen: l.deposit_sen,
    })),
    invoices: z.array(invoiceRow).parse(invoices.data).map((i) => ({
      id: i.id,
      leaseId: i.lease_id,
      kind: i.kind,
      periodIndex: i.period_index,
      periodStart: i.period_start,
      periodEnd: i.period_end,
      dueDate: i.due_date,
      amountSen: i.amount_sen,
    })),
    payments: z.array(paymentRow).parse(payments.data).map((p) => ({
      id: p.id,
      leaseId: p.lease_id,
      amountSen: p.amount_sen,
      unappliedSen: p.unapplied_sen,
      method: p.method,
      status: p.status,
      receivedAt: p.received_at,
    })),
    paidByInvoice,
  };
}

export function TenantPortal() {
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  // "now" exists only on the client after mount, so statuses never differ between server and browser (R52).
  const [now, setNow] = useState<Date | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    loadData()
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setNow(new Date());
        setFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        toast.error("Could not load your tenancy");
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  function reload() {
    setData(null);
    setFailed(false);
    setReloadKey((k) => k + 1);
  }

  if (failed) {
    return (
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>Something went wrong</CardTitle>
          <CardDescription>Your tenancy could not be loaded.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={reload}>Try again</Button>
        </CardContent>
      </Card>
    );
  }

  if (!data || !now) return <PortalSkeleton />;

  if (data.tenants.length === 0) {
    return (
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>No tenancy found</CardTitle>
          <CardDescription>This account is not linked to a tenant profile.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">My tenancy</h1>
        <Button variant="outline" onClick={reload}>
          Refresh
        </Button>
      </div>

      {data.tenants.map((t) => (
        <Card key={t.id}>
          <CardHeader>
            <CardTitle>{t.full_name}</CardTitle>
            <CardDescription>{t.email}</CardDescription>
          </CardHeader>
          <CardContent>
            <PhoneForm
              tenantId={t.id}
              phone={t.phone}
              onSaved={(phone) =>
                setData((d) => (d ? { ...d, tenants: d.tenants.map((x) => (x.id === t.id ? { ...x, phone } : x)) } : d))
              }
            />
          </CardContent>
        </Card>
      ))}

      {data.leases.length === 0 ? (
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>No leases</CardTitle>
            <CardDescription>You do not have a lease yet.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        data.leases.map((lease) => (
          <LeaseSection
            key={lease.id}
            lease={lease}
            invoices={data.invoices.filter((i) => i.leaseId === lease.id)}
            payments={data.payments.filter((p) => p.leaseId === lease.id)}
            paidByInvoice={data.paidByInvoice}
            now={now}
          />
        ))
      )}
    </div>
  );
}

function PortalSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading your tenancy">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}
