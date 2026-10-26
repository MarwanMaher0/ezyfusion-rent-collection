"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export type NavLink = { href: string; label: string };

// Which links to show is decided on the server from the caller's DB role (see AppHeader); this component
// only highlights the current section. It is navigation, not authorization: every page re-checks access.
export function HeaderNav({ links }: { links: NavLink[] }) {
  const pathname = usePathname();
  if (links.length === 0) return null;
  return (
    <nav aria-label="Main navigation" className="flex items-center gap-1">
      {links.map((l) => {
        const active = pathname === l.href || pathname.startsWith(`${l.href}/`);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
