import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { monthLabel } from "@/components/staff/labels";
import { DashboardSkeleton } from "@/components/staff/skeletons";
import { Badge } from "@/components/ui/badge";
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
import { toMytDate } from "@/lib/billing";
import { formatSen } from "@/lib/money";
import { getUserId } from "@/server/auth";
import { loadCaller } from "@/server/access";
import { collectionsReport, overdueCount } from "@/server/services/reports";

const REPORT_MONTHS = 6;

// "YYYY-MM" shifted by a whole number of months; integer month math, no Date (R3/R52).
function shiftMonth(ym: string, delta: number): string {
  const index = Number(ym.slice(0, 4)) * 12 + (Number(ym.slice(5, 7)) - 1) + delta;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

export default async function DashboardPage() {
  const userId = await getUserId();
  if (!userId) redirect("/login");

  const caller = await loadCaller(userId);
  // UX redirect only: the services re-check the role themselves (R36).
  if (!caller.member) {
    if (caller.tenantIds.length > 0) redirect("/tenant");
    return (
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>No access</CardTitle>
          <CardDescription>This account is not linked to an organisation.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Dashboard</h1>
      <Suspense fallback={<DashboardSkeleton />}>
        <DashboardBody userId={userId} />
      </Suspense>
    </>
  );
}

async function DashboardBody({ userId }: { userId: string }) {
  const ctx = { userId };
  const now = new Date();
  // The current month is the Malaysia calendar month of "now", then five months back.
  const currentMonth = toMytDate(now).slice(0, 7);
  const [overdue, report] = await Promise.all([
    overdueCount(ctx, now),
    collectionsReport(ctx, shiftMonth(currentMonth, -(REPORT_MONTHS - 1)), currentMonth),
  ]);

  const total = report.reduce((sum, r) => sum + r.collectedSen, 0);
  const max = report.reduce((m, r) => Math.max(m, r.collectedSen), 0);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardDescription>Overdue invoices</CardDescription>
            <CardTitle className="text-3xl tabular-nums" data-testid="overdue-count">
              <Link href="/leases" className="underline-offset-4 hover:underline" aria-label={`${overdue} overdue invoices, view leases`}>
                {overdue}
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {overdue === 0
              ? "Nothing is overdue. Every invoice past its due date is paid."
              : "Invoices past their due date (Malaysia time) that are not fully paid."}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Collected, last {REPORT_MONTHS} months</CardDescription>
            <CardTitle className="text-3xl tabular-nums">{formatSen(total)}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Approved payments, by the month they were received.
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Collections by month</CardTitle>
          <CardDescription>
            {monthLabel(report[0]?.month ?? currentMonth)} to {monthLabel(currentMonth)}, approved payments only.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {total === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No approved payments in these months yet. Record a payment on a lease to see it here.
            </p>
          ) : null}
          <Table className={total === 0 ? "mt-4" : undefined}>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead className="w-1/2">Collected</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.map((r) => (
                <TableRow key={r.month}>
                  <TableCell className="font-medium">
                    {monthLabel(r.month)}
                    {r.month === currentMonth && (
                      <Badge variant="outline" className="ml-2">
                        This month
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="h-2 w-full rounded-full bg-muted" aria-hidden="true">
                      <div
                        className="h-2 rounded-full bg-primary"
                        style={{ width: max === 0 ? "0%" : `${Math.round((r.collectedSen / max) * 100)}%` }}
                      />
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatSen(r.collectedSen)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
