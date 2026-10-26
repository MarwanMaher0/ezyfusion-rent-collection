import Link from "next/link";
import { SignOutButton } from "./sign-out-button";

export function AppHeader({ email }: { email: string }) {
  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-4">
        <Link href="/" className="text-base font-semibold tracking-tight">
          Rent Collection
        </Link>
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate text-sm text-muted-foreground">{email}</span>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
