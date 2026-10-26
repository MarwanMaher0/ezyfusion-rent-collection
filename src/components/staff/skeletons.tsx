import { Skeleton } from "@/components/ui/skeleton";

// Suspense fallbacks. They sit below the page's access check so a redirect or 404 still gets its real
// HTTP status (a route-level loading.tsx would flush a 200 first).
export function DashboardSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading dashboard">
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
      <Skeleton className="mt-6 h-72" />
    </div>
  );
}

export function LeaseListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading leases">
      <Skeleton className="h-80" />
    </div>
  );
}
