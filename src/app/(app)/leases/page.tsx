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
import { listLeasesPage } from "@/server/services/leases";

// Mirrors the service default; used only to keep default values out of the URL.
const DEFAULT_PAGE_SIZE = 10;

// Builds a /leases URL that keeps q and pageSize and omits defaults (page 1, size 10, empty q).
function leasesHref({ q = "", page = 1, pageSize = DEFAULT_PAGE_SIZE }: { q?: string; page?: number; pageSize?: number }) {
  const params = new URLSearchParams();
  if (q !== "") params.set("q", q);
  if (page > 1) params.set("page", String(page));
  if (pageSize !== DEFAULT_PAGE_SIZE) params.set("pageSize", String(pageSize));
  const qs = params.toString();
  return qs === "" ? "/leases" : `/leases?${qs}`;
}

export default async function LeasesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; page?: string | string[]; pageSize?: string | string[] }>;
}) {
  const userId = await getUserId();
  if (!userId) redirect("/login");

  const caller = await loadCaller(userId);
  // UX redirect only: listLeases and getLease re-check the caller's role and org (R36).
  if (!caller.member) {
    if (caller.tenantIds.length > 0) redirect("/tenant");
    redirect("/");
  }

  const sp = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const q = first(sp.q)?.trim() ?? "";
  // page and pageSize are passed through raw: listLeasesPage validates them and falls back to page 1 / size 10.
  const rawPage = first(sp.page) ?? "";
  const rawPageSize = first(sp.pageSize) ?? "";
  // Only a plain, non-default size is worth carrying through a new search; the service re-validates it.
  const carryPageSize = /^\d+$/.test(rawPageSize) && rawPageSize !== String(DEFAULT_PAGE_SIZE) ? rawPageSize : null;
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
            {/* No page field on purpose: a new search always starts on page 1. */}
            {carryPageSize && <input type="hidden" name="pageSize" value={carryPageSize} />}
            <Button type="submit" variant="outline">
              Search
            </Button>
            {q !== "" && (
              <Link
                href={leasesHref({ pageSize: carryPageSize ? Number(carryPageSize) : DEFAULT_PAGE_SIZE })}
                className="inline-flex items-center px-2 text-sm text-muted-foreground hover:text-foreground"
              >
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

      <Suspense key={`${q}|${rawPage}|${rawPageSize}`} fallback={<LeaseListSkeleton />}>
        <LeaseTable userId={userId} q={q} page={rawPage} pageSize={rawPageSize} />
      </Suspense>
    </>
  );
}

async function LeaseTable({
  userId,
  q,
  page: rawPage,
  pageSize: rawPageSize,
}: {
  userId: string;
  q: string;
  page: string;
  pageSize: string;
}) {
  // Search, ordering and paging all run in the database, scoped by the caller's org (bonus R56).
  const result = await listLeasesPage({ userId }, { q, page: rawPage, pageSize: rawPageSize });
  const { items: leases, total, page, pageSize, pageCount } = result;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

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
        {total > 0 && (
          <nav
            aria-label="Lease pages"
            className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="text-sm text-muted-foreground" aria-live="polite">
              Showing {first}–{last} of {total}
            </p>
            <div className="flex items-center gap-2">
              {page > 1 ? (
                <Link
                  href={leasesHref({ q, page: page - 1, pageSize })}
                  rel="prev"
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  Previous
                </Link>
              ) : (
                <span aria-disabled="true" className={`${buttonVariants({ variant: "outline", size: "sm" })} pointer-events-none opacity-50`}>
                  Previous
                </span>
              )}
              <span className="text-sm tabular-nums text-muted-foreground">
                Page {page} of {pageCount}
              </span>
              {page < pageCount ? (
                <Link
                  href={leasesHref({ q, page: page + 1, pageSize })}
                  rel="next"
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  Next
                </Link>
              ) : (
                <span aria-disabled="true" className={`${buttonVariants({ variant: "outline", size: "sm" })} pointer-events-none opacity-50`}>
                  Next
                </span>
              )}
            </div>
          </nav>
        )}
      </CardContent>
    </Card>
  );
}
