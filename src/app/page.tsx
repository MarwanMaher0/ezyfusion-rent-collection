import Link from "next/link";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-shell/app-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { loadCaller } from "@/server/access";

export default async function Home() {
  const supabase = await createClient();
  // getUser() validates the JWT with Supabase; getSession() would trust the cookie.
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) redirect("/login");

  // Role comes from memberships/tenants in the DB, never user_metadata (R36).
  const caller = await loadCaller(data.user.id);
  const links: { href: string; label: string }[] = [];
  if (caller.member) links.push({ href: "/dashboard", label: "Open dashboard" });
  if (caller.tenantIds.length > 0) links.push({ href: "/tenant", label: "Open my tenancy" });

  return (
    <>
      <AppHeader email={data.user.email ?? ""} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Welcome</CardTitle>
            <CardDescription>
              {links.length > 0
                ? "Choose where to go."
                : "This account is not linked to an organisation or a tenancy."}
            </CardDescription>
          </CardHeader>
          {links.length > 0 && (
            <CardContent className="flex flex-col gap-2">
              {links.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className="text-sm font-medium underline-offset-4 hover:underline"
                >
                  {l.label}
                </Link>
              ))}
            </CardContent>
          )}
        </Card>
      </main>
    </>
  );
}
