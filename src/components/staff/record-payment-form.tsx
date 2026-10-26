"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MYT_OFFSET_MS } from "@/lib/billing";
import { mytLocalToIso } from "@/lib/dates";
import { formatSen, parseRinggitToSen } from "@/lib/money";
import { createClient } from "@/lib/supabase/browser";
import { callApi } from "./api";

const SLIP_BUCKET = "payment-slips";
const MAX_SLIP_BYTES = 5 * 1024 * 1024; // R20: at most 5 MB (the bucket enforces the same limit)
const SLIP_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf",
};

type Method = "cash" | "bank_transfer";
const METHOD_ITEMS: { value: Method; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "bank_transfer", label: "Bank transfer" },
];

type FieldErrors = { amount?: string; receivedAt?: string; slip?: string };

// "Now" as a datetime-local value in Malaysia time. Computed on the client only (after mount), by shifting
// the instant by the fixed +08:00 offset, so it never depends on the browser's zone (R52).
function nowInMytLocal(): string {
  return new Date(Date.now() + MYT_OFFSET_MS).toISOString().slice(0, 16);
}

function validateSlip(file: File | null): string | undefined {
  if (!file) return "Attach the bank transfer slip (JPEG, PNG or PDF).";
  if (!(file.type in SLIP_EXT)) return "The slip must be a JPEG, PNG or PDF file.";
  if (file.size > MAX_SLIP_BYTES) return "The slip must be 5 MB or smaller.";
  return undefined;
}

type Props = { leaseId: string; orgId: string; isManager: boolean };

export function RecordPaymentForm({ leaseId, orgId, isManager }: Props) {
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<Method>("cash");
  const [receivedAt, setReceivedAt] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // D9: one optional Idempotency-Key per form render protects against a double click; a new one after success.
  const keyRef = useRef<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only default avoids a hydration mismatch
    setReceivedAt(nowInMytLocal());
  }, []);

  function onAmountChange(value: string) {
    setAmount(value);
    if (errors.amount) setErrors((e) => ({ ...e, amount: undefined }));
  }

  function validate(): { amountSen: number; receivedAtIso: string } | null {
    const next: FieldErrors = {};
    let amountSen = 0;
    try {
      amountSen = parseRinggitToSen(amount);
      if (!Number.isSafeInteger(amountSen)) throw new Error("too large");
      if (amountSen <= 0) next.amount = "The amount must be greater than zero.";
    } catch {
      next.amount = "Enter an amount like 1,500.00";
    }
    let receivedAtIso = "";
    if (!receivedAt) {
      next.receivedAt = "Choose when the payment was received (Malaysia time).";
    } else {
      try {
        receivedAtIso = mytLocalToIso(receivedAt);
      } catch {
        next.receivedAt = "Enter a valid date and time (Malaysia time).";
      }
    }
    if (method === "bank_transfer") {
      const slipError = validateSlip(file);
      if (slipError) next.slip = slipError;
    }
    setErrors(next);
    return Object.keys(next).length === 0 ? { amountSen, receivedAtIso } : null;
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    const valid = validate();
    if (!valid) return;

    setSubmitting(true);
    const supabase = createClient();
    let slipPath: string | undefined;

    if (method === "bank_transfer" && file) {
      // R44: path <org_id>/<lease_id>/<uuid>.<ext>; Storage RLS only lets this org's staff upload here.
      slipPath = `${orgId}/${leaseId}/${crypto.randomUUID()}.${SLIP_EXT[file.type]}`;
      const { error } = await supabase.storage
        .from(SLIP_BUCKET)
        .upload(slipPath, file, { contentType: file.type, upsert: false });
      if (error) {
        toast.error(`Slip upload failed: ${error.message}`);
        setSubmitting(false);
        return;
      }
    }

    keyRef.current ??= crypto.randomUUID();
    const res = await callApi<{ id: string; status: string }>(`/api/leases/${leaseId}/payments`, {
      method: "POST",
      headers: { "Idempotency-Key": keyRef.current },
      body: {
        amountSen: valid.amountSen,
        method,
        receivedAt: valid.receivedAtIso,
        ...(slipPath ? { slipPath } : {}),
      },
    });

    if (!res.ok) {
      toast.error(res.error);
      if (slipPath) {
        // R20: the server removes the orphan slip itself; this is a best-effort second attempt (the
        // browser role has no DELETE policy, so it may be refused, which is fine).
        await supabase.storage.from(SLIP_BUCKET).remove([slipPath]).catch(() => undefined);
      }
      setSubmitting(false);
      return;
    }

    toast.success(
      res.data.status === "approved"
        ? `Payment of ${formatSen(valid.amountSen)} recorded and approved.`
        : `Payment of ${formatSen(valid.amountSen)} recorded. It waits for a manager's approval.`,
    );
    keyRef.current = null;
    setAmount("");
    setFile(null);
    setErrors({});
    if (fileRef.current) fileRef.current.value = "";
    setReceivedAt(nowInMytLocal());
    setSubmitting(false);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4 sm:grid-cols-2">
      <div className="flex flex-col gap-2">
        <Label htmlFor="amount">Amount (RM)</Label>
        <Input
          id="amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder="1,500.00"
          value={amount}
          onChange={(e) => onAmountChange(e.target.value)}
          aria-invalid={Boolean(errors.amount)}
          aria-describedby={errors.amount ? "amount-error" : undefined}
          disabled={submitting}
        />
        {errors.amount && (
          <p id="amount-error" className="text-sm text-destructive">
            {errors.amount}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="method">Method</Label>
        <Select
          value={method}
          items={METHOD_ITEMS}
          onValueChange={(v) => {
            if (v === "cash" || v === "bank_transfer") {
              setMethod(v);
              setErrors((e) => ({ ...e, slip: undefined }));
            }
          }}
          disabled={submitting}
        >
          <SelectTrigger id="method" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {METHOD_ITEMS.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="received-at">Received at (Malaysia time)</Label>
        <Input
          id="received-at"
          type="datetime-local"
          value={receivedAt}
          onChange={(e) => {
            setReceivedAt(e.target.value);
            if (errors.receivedAt) setErrors((er) => ({ ...er, receivedAt: undefined }));
          }}
          aria-invalid={Boolean(errors.receivedAt)}
          aria-describedby={errors.receivedAt ? "received-at-error" : undefined}
          disabled={submitting}
        />
        {errors.receivedAt && (
          <p id="received-at-error" className="text-sm text-destructive">
            {errors.receivedAt}
          </p>
        )}
      </div>

      {method === "bank_transfer" && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="slip">Bank transfer slip (JPEG, PNG or PDF, up to 5 MB)</Label>
          <Input
            id="slip"
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,application/pdf"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              setErrors((er) => ({ ...er, slip: f ? validateSlip(f) : undefined }));
            }}
            aria-invalid={Boolean(errors.slip)}
            aria-describedby={errors.slip ? "slip-error" : undefined}
            disabled={submitting}
          />
          {errors.slip && (
            <p id="slip-error" className="text-sm text-destructive">
              {errors.slip}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {isManager
            ? "Payments you record are approved immediately."
            : "Payments you record wait for a manager's approval."}
        </p>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Recording..." : "Record payment"}
        </Button>
      </div>
    </form>
  );
}
