import { AppHeader } from "@/components/app-shell/app-header";
import { createClient } from "@/lib/supabase/server";

// Outside the (app) group on purpose: that layout redirects to a bare /login, which would drop the
// bill id. The return page does its own login redirect with ?next= (and its own authorization).
export default async function PaymentsLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  return (
    <>
      {data.user && <AppHeader email={data.user.email ?? ""} />}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
    </>
  );
}
