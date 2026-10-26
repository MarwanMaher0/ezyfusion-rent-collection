import { TenantPortal } from "@/components/tenant/tenant-portal";

export const metadata = { title: "My tenancy" };

// The (app) layout redirects visitors without a session. Data is read in the browser with supabase-js,
// so Postgres RLS (not this page) decides what the signed-in tenant sees.
export default function TenantPage() {
  return <TenantPortal />;
}
