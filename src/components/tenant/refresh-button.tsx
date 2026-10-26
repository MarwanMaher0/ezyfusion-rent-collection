"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

// Re-runs the server component so the real bill status is read from the DB again; it writes nothing.
export function RefreshButton() {
  const router = useRouter();
  return (
    <Button variant="outline" onClick={() => router.refresh()}>
      Refresh status
    </Button>
  );
}
