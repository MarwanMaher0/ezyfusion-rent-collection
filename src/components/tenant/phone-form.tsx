"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/browser";

// Same shape as the tenants.phone CHECK: optional +, a digit, then 5-19 digits, spaces or dashes (6-20 chars).
const PHONE_RE = /^\+?[0-9][0-9 -]{5,19}$/;

export function PhoneForm({
  tenantId,
  phone,
  onSaved,
}: {
  tenantId: string;
  phone: string | null;
  onSaved: (phone: string) => void;
}) {
  const [value, setValue] = useState(phone ?? "");
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const next = value.trim();
    if (!PHONE_RE.test(next)) {
      setInvalid("Use digits, spaces or dashes with an optional leading +, 6 to 20 characters.");
      return;
    }
    setInvalid(null);
    setSaving(true);
    // R42: the browser writes straight to PostgREST; RLS and the column grant allow only the own row's phone.
    const { data, error } = await createClient().from("tenants").update({ phone: next }).eq("id", tenantId).select();
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (!data || data.length === 0) {
      toast.error("Your phone number was not updated");
      return;
    }
    setValue(next);
    onSaved(next);
    toast.success("Phone number updated");
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2" noValidate>
      <Label htmlFor={`phone-${tenantId}`}>Phone number</Label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={`phone-${tenantId}`}
          name="phone"
          type="tel"
          autoComplete="tel"
          className="max-w-xs"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={saving}
          aria-invalid={invalid !== null}
          aria-describedby={invalid ? `phone-error-${tenantId}` : undefined}
        />
        <Button type="submit" disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
      {invalid && (
        <p id={`phone-error-${tenantId}`} className="text-sm text-destructive">
          {invalid}
        </p>
      )}
    </form>
  );
}
