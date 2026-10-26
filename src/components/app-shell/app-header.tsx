import Link from "next/link";
import { loadCaller } from "@/server/access";
import { getUserId } from "@/server/auth";
import { HeaderNav, type NavLink } from "./header-nav";
import { SignOutButton } from "./sign-out-button";

// Links follow the DB role (memberships / tenants.user_id), never user_metadata. If the lookup fails the
// header still renders, just without links.
async function navLinks(): Promise<NavLink[]> {
  try {
    const userId = await getUserId();
    if (!userId) return [];
    const caller = await loadCaller(userId);
    const links: NavLink[] = [];
    if (caller.member) {
      links.push({ href: "/dashboard", label: "Dashboard" }, { href: "/leases", label: "Leases" });
    }
    if (caller.tenantIds.length > 0) links.push({ href: "/tenant", label: "My tenancy" });
    return links;
  } catch {
    return [];
  }
}

export async function AppHeader({ email }: { email: string }) {
  const links = await navLinks();
  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-4">
        <div className="flex min-w-0 items-center gap-4">
          <Link href="/" className="shrink-0 text-base font-semibold tracking-tight">
            Rent Collection
          </Link>
          <HeaderNav links={links} />
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <span className="hidden truncate text-sm text-muted-foreground sm:inline">{email}</span>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
