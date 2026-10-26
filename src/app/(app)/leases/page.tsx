import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { LeaseListSkeleton } from "@/components/staff/skeletons";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatSen } from "@/lib/money";
import { loadCaller } from "@/server/access";
import { getUserId } from "@/server/auth";
import { listLeases } from "@/server/services/leases";

export default async function LeasesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const userId = await getUserId();
  if (!userId) redirect("/login");

  const caller = await loadCaller(userId);
  // UX redirect only: listLeases and getLease re-check the caller's role and org (R36).
  if (!caller.member) {
    if (caller.tenantIds.length > 0) redirect("/tenant");
    redirect("/");
  }

  const { q: rawQ } = await searchParams;
  const q = (Array.isArray(rawQ) ? rawQ[0] : rawQ)?.trim() ?? "";
  return (
    <>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Leases</h1>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <form action="/leases" method="get" role="search" className="flex gap-2">
            <Input
              name="q"
              type="search"
              defaultValue={q}
              placeholder="Search unit or tenant"
              aria-label="Search by unit or tenant"
              className="w-64"
            />
            <Button type="submit" variant="outline">
              Search
            </Button>
            {q !== "" && (
              <Link href="/leases" className="inline-flex items-center px-2 text-sm text-muted-foreground hover:text-foreground">
                Clear
              </Link>
            )}
          </form>
          {caller.member.role === "manager" && (
            <Link href="/leases/new" className={buttonVariants()}>
              New lease
            </Link>
          )}
        </div>
      </div>

      <Suspense key={q} fallback={<LeaseListSkeleton />}>
        <LeaseTable userId={userId} q={q} />
      </Suspense>
    </>
  );
}

async function LeaseTable({ userId, q }: { userId: string; q: string }) {
  const all = await listLeases({ userId });
  // Server-side search on unit or tenant name (bonus R56), case-insensitive substring.
  const needle = q.toLowerCase();
  const leases =
    needle === ""
      ? all
      : all.filter(
          (l) => l.unitName.toLowerCase().includes(needle) || l.tenantName.toLowerCase().includes(needle),
        );

  return (
    <Card>
      <CardContent>
        {leases.length === 0 ? (
          <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            {q === ""
              ? "There are no leases in your organisation yet."
              : `No lease matches "${q}". Try a different unit or tenant name.`}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Unit</TableHead>
                <TableHead>Tenant</TableHead>
                <TableHead>Start</TableHead>
                <TableHead>End</TableHead>
                <TableHead className="text-right">Monthly rent</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Open</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leases.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="font-medium">{l.unitName}</TableCell>
                  <TableCell>{l.tenantName}</TableCell>
                  <TableCell className="tabular-nums">{l.startDate}</TableCell>
                  <TableCell className="tabular-nums">{l.endDate}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatSen(l.monthlyRentSen)}</TableCell>
                  <TableCell className="text-right">
                    <Link
                      href={`/leases/${l.id}`}
                      className="text-sm font-medium underline-offset-4 hover:underline"
                    >
                      View
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
