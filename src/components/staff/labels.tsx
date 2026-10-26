import { Badge } from "@/components/ui/badge";
import type { InvoiceStatus } from "@/lib/billing";

// Pure presentation helpers; usable from server and client components. No dates are formatted here
// except month labels, which are built from the "YYYY-MM" string (no Date, no time zone).

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// "2026-05" -> "May 2026"
export function monthLabel(ym: string): string {
  const name = MONTH_NAMES[Number(ym.slice(5, 7)) - 1];
  return name ? `${name} ${ym.slice(0, 4)}` : ym;
}

const INVOICE_STATUS: Record<
  InvoiceStatus,
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  paid: { label: "Paid", variant: "default" },
  partially_paid: { label: "Partially paid", variant: "secondary" },
  unpaid: { label: "Unpaid", variant: "outline" },
  overdue: { label: "Overdue", variant: "destructive" },
};

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const s = INVOICE_STATUS[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

export type PaymentStatusValue =
  | "pending_verification"
  | "approved"
  | "rejected"
  | "voided";

const PAYMENT_STATUS: Record<
  PaymentStatusValue,
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  pending_verification: { label: "Pending verification", variant: "secondary" },
  approved: { label: "Approved", variant: "default" },
  rejected: { label: "Rejected", variant: "destructive" },
  voided: { label: "Voided", variant: "outline" },
};

export function paymentStatusLabel(status: PaymentStatusValue): string {
  return PAYMENT_STATUS[status].label;
}

export function PaymentStatusBadge({ status }: { status: PaymentStatusValue }) {
  const s = PAYMENT_STATUS[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

const METHOD_LABEL: Record<"cash" | "bank_transfer" | "online", string> = {
  cash: "Cash",
  bank_transfer: "Bank transfer",
  online: "Online",
};

export function methodLabel(method: "cash" | "bank_transfer" | "online"): string {
  return METHOD_LABEL[method];
}
