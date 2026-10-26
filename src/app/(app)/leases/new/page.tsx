import Link from "next/link";
import { redirect } from "next/navigation";
import { NewLeaseForm } from "@/components/staff/new-lease-form";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loadCaller } from "@/server/access";
import { getUserId } from "@/server/auth";
import { leaseFormOptions } from "@/server/services/leases";

export const metadata = { title: "New lease" };

export default async function NewLeasePage() {
  const userId = await getUserId();
  if (!userId) redirect("/login");

  const caller = await loadCaller(userId);
  if (!caller.member) {
    if (caller.tenantIds.length > 0) redirect("/tenant");
    redirect("/");
  }
  // UX only: leaseFormOptions and POST /api/leases both re-check that the caller is a manager (R36).
  if (caller.member.role !== "manager") {
    return (
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>Only managers can create leases</CardTitle>
          <CardDescription>
            Ask a manager to create the lease, or go back to the{" "}
            <Link href="/leases" className="underline underline-offset-4">
              leases list
            </Link>
            .
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const options = await leaseFormOptions({ userId });
  return (
    <>
      <div className="mb-6">
        <Link href="/leases" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          Back to leases
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New lease</h1>
        <p className="text-sm text-muted-foreground">
          The invoice schedule below is calculated as you type, with the same rules the server applies.
        </p>
      </div>
      <NewLeaseForm units={options.units} tenants={options.tenants} />
    </>
  );
}
