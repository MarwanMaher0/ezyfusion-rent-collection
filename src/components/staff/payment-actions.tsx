"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { callApi } from "./api";

const MIN_REASON = 5;

type Props = {
  paymentId: string;
  status: "pending_verification" | "approved" | "rejected" | "voided";
  amountLabel: string;
};

// R24: manager-only actions. The buttons are only rendered for managers, but the routes enforce the role
// themselves (a hidden button is not a check, R36).
export function PaymentActions({ paymentId, status, amountLabel }: Props) {
  const router = useRouter();
  const [approving, setApproving] = useState(false);

  async function approve() {
    setApproving(true);
    const res = await callApi(`/api/payments/${paymentId}/approve`, { method: "POST" });
    setApproving(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(`Payment of ${amountLabel} approved.`);
    router.refresh();
  }

  if (status === "pending_verification") {
    return (
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" onClick={approve} disabled={approving}>
          {approving ? "Approving..." : "Approve"}
        </Button>
        <ReasonDialog
          paymentId={paymentId}
          action="reject"
          triggerLabel="Reject"
          title="Reject this payment?"
          description={`The payment of ${amountLabel} stays on record as rejected and is not allocated to any invoice.`}
          confirmLabel="Reject payment"
          busyLabel="Rejecting..."
          successMessage={`Payment of ${amountLabel} rejected.`}
        />
      </div>
    );
  }

  if (status === "approved") {
    return (
      <div className="flex justify-end">
        <ReasonDialog
          paymentId={paymentId}
          action="void"
          triggerLabel="Void"
          title="Void this payment?"
          description={`This releases the allocations of the ${amountLabel} payment, so the invoices it paid become unpaid again. The payment itself is kept on record.`}
          confirmLabel="Void payment"
          busyLabel="Voiding..."
          successMessage={`Payment of ${amountLabel} voided.`}
        />
      </div>
    );
  }

  return <span className="text-muted-foreground">-</span>;
}

type ReasonDialogProps = {
  paymentId: string;
  action: "reject" | "void";
  triggerLabel: string;
  title: string;
  description: string;
  confirmLabel: string;
  busyLabel: string;
  successMessage: string;
};

function ReasonDialog(p: ReasonDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  const tooShort = reason.trim().length < MIN_REASON;
  const showError = touched && tooShort;
  const fieldId = `${p.action}-reason-${p.paymentId}`;

  function onOpenChange(next: boolean) {
    if (busy) return;
    setOpen(next);
    if (!next) {
      setReason("");
      setTouched(false);
    }
  }

  async function confirm() {
    setTouched(true);
    if (tooShort) return;
    setBusy(true);
    const res = await callApi(`/api/payments/${p.paymentId}/${p.action}`, {
      method: "POST",
      body: { reason: reason.trim() },
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(p.successMessage);
    setOpen(false);
    setReason("");
    setTouched(false);
    router.refresh();
  }

  return (
    <>
      <Button type="button" size="sm" variant="destructive" onClick={() => setOpen(true)}>
        {p.triggerLabel}
      </Button>
      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{p.title}</AlertDialogTitle>
            <AlertDialogDescription>{p.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={fieldId}>Reason (at least {MIN_REASON} characters)</Label>
            <Textarea
              id={fieldId}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={showError}
              aria-describedby={showError ? `${fieldId}-error` : undefined}
              disabled={busy}
              placeholder="Why are you doing this?"
            />
            {showError && (
              <p id={`${fieldId}-error`} className="text-sm text-destructive">
                Enter a reason of at least {MIN_REASON} characters.
              </p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button type="button" variant="destructive" onClick={confirm} disabled={busy}>
              {busy ? p.busyLabel : p.confirmLabel}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
