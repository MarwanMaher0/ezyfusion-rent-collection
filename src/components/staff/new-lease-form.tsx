"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { generateSchedule, type ScheduledInvoice } from "@/lib/billing";
import { formatSen, parseRinggitToSen } from "@/lib/money";
import { callApi } from "./api";

type UnitOption = { id: string; name: string };
type TenantOption = { id: string; fullName: string; email: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// A schedule can legitimately be long (years of months); render a bounded number of rows, total stays exact.
const MAX_PREVIEW_ROWS = 120;

type Preview =
  | { kind: "hint"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ok"; rows: ScheduledInvoice[]; totalSen: number };

// Pure function of the form values. Dates stay "YYYY-MM-DD" strings (never new Date(string), R52) and
// money goes through parseRinggitToSen; friendly checks run first and anything generateSchedule still rejects shows a generic hint.
function buildPreview(startDate: string, endDate: string, rent: string, deposit: string): Preview {
  // Missing input is a neutral hint (the form starts empty); a wrong value is an error.
  if (rent.trim() === "") {
    return { kind: "hint", message: "Enter a monthly rent greater than RM 0.00" };
  }
  let monthlyRentSen: number;
  try {
    monthlyRentSen = parseRinggitToSen(rent);
  } catch {
    return { kind: "error", message: "Monthly rent must be an amount like 1,500.00." };
  }
  if (monthlyRentSen <= 0) {
    return { kind: "error", message: "Enter a monthly rent greater than RM 0.00" };
  }
  if (!ISO_DATE.test(startDate) || !ISO_DATE.test(endDate)) {
    return { kind: "hint", message: "Choose a start and end date" };
  }
  // Both are YYYY-MM-DD, so string comparison is chronological (no Date parsing, R52).
  if (endDate < startDate) {
    return { kind: "error", message: "The end date must be on or after the start date" };
  }
  let depositSen = 0;
  if (deposit.trim() !== "") {
    try {
      depositSen = parseRinggitToSen(deposit);
    } catch {
      return { kind: "error", message: "Deposit must be an amount like 3,000.00, or empty for no deposit." };
    }
  }
  try {
    const rows = generateSchedule({ startDate, endDate, monthlyRentSen, depositSen });
    return { kind: "ok", rows, totalSen: rows.reduce((sum, r) => sum + r.amountSen, 0) };
  } catch {
    // generateSchedule's own message is developer-facing; never shown to the user.
    return { kind: "error", message: "Check the dates and amounts" };
  }
}

function kindLabel(r: ScheduledInvoice): string {
  return r.kind === "deposit" ? "Deposit" : `Rent ${(r.periodIndex ?? 0) + 1}`;
}

export function NewLeaseForm({ units, tenants }: { units: UnitOption[]; tenants: TenantOption[] }) {
  const router = useRouter();
  const [unitId, setUnitId] = useState<string | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [rent, setRent] = useState("");
  const [deposit, setDeposit] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const preview = useMemo(() => buildPreview(startDate, endDate, rent, deposit), [startDate, endDate, rent, deposit]);

  const unitItems = units.map((u) => ({ value: u.id, label: u.name }));
  const tenantItems = tenants.map((t) => ({ value: t.id, label: `${t.fullName} (${t.email})` }));

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    if (!unitId) return void toast.error("Choose a unit.");
    if (!tenantId) return void toast.error("Choose a tenant.");
    if (preview.kind !== "ok") {
      return void toast.error(preview.message);
    }

    setSubmitting(true);
    try {
      const res = await callApi<{ id: string }>("/api/leases", {
        method: "POST",
        body: {
          unitId,
          tenantId,
          startDate,
          endDate,
          monthlyRentSen: parseRinggitToSen(rent),
          depositSen: deposit.trim() === "" ? 0 : parseRinggitToSen(deposit),
        },
      });
      if (!res.ok) {
        toast.error(
          res.status === 409 ? "This unit already has a lease that overlaps these dates" : res.error,
        );
        setSubmitting(false);
        return;
      }
      // Stay in the submitting state after success: the page navigates away, and re-enabling the
      // button here would let a second click create a duplicate lease.
      toast.success("Lease created.");
      router.push(`/leases/${res.data.id}`);
    } catch {
      toast.error("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  if (units.length === 0 || tenants.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        {units.length === 0 ? "Your organisation has no units yet." : "Your organisation has no tenants yet."} A lease
        needs both a unit and a tenant.
      </p>
    );
  }

  const shown = preview.kind === "ok" ? preview.rows.slice(0, MAX_PREVIEW_ROWS) : [];

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Lease details</CardTitle>
          <CardDescription>Amounts are in ringgit. Dates are calendar dates.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} noValidate className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="unit">Unit</Label>
              <Select value={unitId} items={unitItems} onValueChange={setUnitId} disabled={submitting}>
                <SelectTrigger id="unit" className="w-full">
                  <SelectValue placeholder="Select a unit" />
                </SelectTrigger>
                <SelectContent>
                  {unitItems.map((u) => (
                    <SelectItem key={u.value} value={u.value}>
                      {u.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="tenant">Tenant</Label>
              <Select value={tenantId} items={tenantItems} onValueChange={setTenantId} disabled={submitting}>
                <SelectTrigger id="tenant" className="w-full">
                  <SelectValue placeholder="Select a tenant" />
                </SelectTrigger>
                <SelectContent>
                  {tenantItems.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="start-date">Start date</Label>
              <Input
                id="start-date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                disabled={submitting}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="end-date">End date</Label>
              <Input
                id="end-date"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                disabled={submitting}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="monthly-rent">Monthly rent (RM)</Label>
              <Input
                id="monthly-rent"
                inputMode="decimal"
                autoComplete="off"
                placeholder="1,500.00"
                value={rent}
                onChange={(e) => setRent(e.target.value)}
                disabled={submitting}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="deposit">Deposit (RM, optional)</Label>
              <Input
                id="deposit"
                inputMode="decimal"
                autoComplete="off"
                placeholder="3,000.00"
                value={deposit}
                onChange={(e) => setDeposit(e.target.value)}
                disabled={submitting}
              />
            </div>

            <div className="flex justify-end sm:col-span-2">
              <Button type="submit" disabled={submitting}>
                {submitting ? "Creating..." : "Create lease"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invoice schedule preview</CardTitle>
          <CardDescription>The invoices that will be created with this lease.</CardDescription>
        </CardHeader>
        <CardContent>
          {preview.kind === "hint" && (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              {preview.message}
            </p>
          )}
          {preview.kind === "error" && (
            <p role="alert" className="rounded-lg border border-destructive/40 p-4 text-sm text-destructive">
              {preview.message}
            </p>
          )}
          {preview.kind === "ok" && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((r) => (
                  <TableRow key={`${r.kind}-${r.periodIndex ?? "d"}`}>
                    <TableCell className="font-medium">{kindLabel(r)}</TableCell>
                    <TableCell className="tabular-nums">
                      {r.periodStart && r.periodEnd ? `${r.periodStart} to ${r.periodEnd}` : "-"}
                    </TableCell>
                    <TableCell className="tabular-nums">{r.dueDate}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatSen(r.amountSen)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={3} className="font-medium">
                    Total ({preview.rows.length} {preview.rows.length === 1 ? "invoice" : "invoices"})
                    {preview.rows.length > shown.length && `, first ${shown.length} shown`}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums" data-testid="schedule-total">
                    {formatSen(preview.totalSen)}
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
