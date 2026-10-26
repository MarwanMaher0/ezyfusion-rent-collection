import Link from "next/link";
import { redirect } from "next/navigation";
import { RefreshButton } from "@/components/tenant/refresh-button";
import { Badge } from "@/components/ui/badge";
import { TONE } from "@/components/staff/labels";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError } from "@/lib/errors";
import { formatSen } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { getGatewayBill, type GatewayBillDto } from "@/server/services/gateway";

export const metadata = { title: "Payment status" };
export const dynamic = "force-dynamic";

const MESSAGE: Record<GatewayBillDto["status"], string> = {
  pending: "We are waiting for the gateway to confirm your payment.",
  paid: "Payment received. Thank you.",
  failed: "The payment failed. You can start a new payment from your tenancy page.",
};

// R31: strictly read-only. Only the gateway webhook settles a bill, so the `paid` query parameter is never
// read here; the status shown is whatever the database says.
export default async function PaymentReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ bill_id?: string | string[] }>;
}) {
  const { bill_id } = await searchParams;
  const billId = Array.isArray(bill_id) ? bill_id[0] : bill_id;

  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    // Send the tenant back here after signing in; the login form only follows same-origin paths.
    const back = `/payments/return${billId ? `?bill_id=${encodeURIComponent(billId)}` : ""}`;
    redirect(`/login?next=${encodeURIComponent(back)}`);
  }

  let bill: GatewayBillDto | null = null;
  if (billId) {
    try {
      bill = await getGatewayBill({ userId: data.user.id }, billId);
    } catch (e) {
      // Unknown, malformed or someone else's bill all look the same (R38); anything else is a real error.
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    }
  }

  return (
    <Card className="max-w-lg">
      <CardHeader>
        <CardTitle>Payment status</CardTitle>
        {bill && <CardDescription>The status below is read from our records.</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {bill ? (
          <>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className={TONE[bill.status === "paid" ? "green" : bill.status === "failed" ? "red" : "amber"]}>
                {bill.status === "paid" ? "Paid" : bill.status === "failed" ? "Failed" : "Pending"}
              </Badge>
              <p className="text-sm" data-testid="bill-status-message">
                {MESSAGE[bill.status]}
              </p>
            </div>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Bill id</dt>
              <dd className="font-mono break-all">{bill.billId}</dd>
              <dt className="text-muted-foreground">Amount</dt>
              <dd className="tabular-nums">{formatSen(bill.amountSen)}</dd>
            </dl>
          </>
        ) : (
          <p className="text-sm" data-testid="bill-status-message">
            Bill not found
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {bill?.status === "pending" && <RefreshButton />}
          <Link href="/tenant" className={cn(buttonVariants({ variant: "outline" }))}>
            Back to my tenancy
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
