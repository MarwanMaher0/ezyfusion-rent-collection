"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { callApi } from "./api";

// R44: the slip is never read from Storage by the browser; the server signs a 60 s URL from the DB row.
export function ViewSlipButton({ paymentId }: { paymentId: string }) {
  const [loading, setLoading] = useState(false);

  async function open() {
    setLoading(true);
    // Open the tab synchronously (inside the click) so popup blockers allow it, then point it at the URL.
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    const res = await callApi<{ url?: unknown }>(`/api/payments/${paymentId}/slip`, { method: "GET" });
    setLoading(false);
    if (!res.ok) {
      tab?.close();
      toast.error(res.error);
      return;
    }
    const url = res.data.url;
    if (typeof url !== "string" || url.length === 0) {
      tab?.close();
      toast.error("The server did not return a slip link.");
      return;
    }
    if (tab) {
      tab.location.href = url;
    } else {
      toast.info("Your browser blocked the new tab.", {
        action: { label: "Open slip", onClick: () => window.open(url, "_blank", "noopener") },
      });
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={open} disabled={loading}>
      {loading ? "Opening..." : "View slip"}
    </Button>
  );
}
