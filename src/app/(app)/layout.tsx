import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-shell/app-header";
import { createClient } from "@/lib/supabase/server";

// UX redirect only: every page and API route still authorizes on its own.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) redirect("/login");

  return (
    <>
      <AppHeader email={data.user.email ?? ""} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
    </>
  );
}
