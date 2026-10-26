import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { loadCaller } from "@/server/access";
import { getUserId } from "@/server/auth";
import { HeaderNav, type NavLink } from "./header-nav";
import { SignOutButton } from "./sign-out-button";

// Links follow the DB role (memberships / tenants.user_id), never user_metadata. If the lookup fails the
// header still renders, just without links.
async function navLinks(): Promise<{ links: NavLink[]; role: string | null }> {
  try {
    const userId = await getUserId();
    if (!userId) return { links: [], role: null };
    const caller = await loadCaller(userId);
    const links: NavLink[] = [];
    if (caller.member) {
      links.push({ href: "/dashboard", label: "Dashboard" }, { href: "/leases", label: "Leases" });
    }
    if (caller.tenantIds.length > 0) links.push({ href: "/tenant", label: "My tenancy" });
    // Same caller lookup as the links, so the role badge costs no extra query.
    const role = caller.member ? caller.member.role : caller.tenantIds.length > 0 ? "tenant" : null;
    return { links, role };
  } catch {
    return { links: [], role: null };
  }
}

export async function AppHeader({ email }: { email: string }) {
  const { links, role } = await navLinks();
  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-4">
        <div className="flex min-w-0 items-center gap-4">
          <Link href="/" className="shrink-0 rounded-sm text-base font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Rent Collection
          </Link>
          <HeaderNav links={links} />
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <span className="hidden truncate text-sm text-muted-foreground sm:inline">{email}</span>
          {role && (
            <Badge variant="outline" className="capitalize" data-testid="role-badge">
              {role}
            </Badge>
          )}
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
