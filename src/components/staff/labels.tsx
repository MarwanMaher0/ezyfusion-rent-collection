import { Badge } from "@/components/ui/badge";
import type { InvoiceStatus } from "@/lib/billing";

// Fixed tones (colour AND text label, never colour alone): green = settled, amber = needs attention,
// grey = inactive, red = overdue.
export const TONE = {
  green: "border-transparent bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  amber: "border-transparent bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-300",
  grey: "border-transparent bg-muted text-muted-foreground",
  red: "border-transparent bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
} as const;
export type Tone = keyof typeof TONE;

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
  { label: string; tone: Tone }
> = {
  paid: { label: "Paid", tone: "green" },
  partially_paid: { label: "Partially paid", tone: "amber" },
  unpaid: { label: "Unpaid", tone: "grey" },
  overdue: { label: "Overdue", tone: "red" },
};

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const s = INVOICE_STATUS[status];
  return <Badge variant="outline" className={TONE[s.tone]}>{s.label}</Badge>;
}

export type PaymentStatusValue =
  | "pending_verification"
  | "approved"
  | "rejected"
  | "voided";

const PAYMENT_STATUS: Record<
  PaymentStatusValue,
  { label: string; tone: Tone }
> = {
  pending_verification: { label: "Pending verification", tone: "amber" },
  approved: { label: "Approved", tone: "green" },
  rejected: { label: "Rejected", tone: "grey" },
  voided: { label: "Voided", tone: "grey" },
};

// Rejected and voided payments no longer count: their amount is struck through.
export function paymentAmountClass(status: PaymentStatusValue): string {
  return status === "rejected" || status === "voided" ? "line-through text-muted-foreground" : "";
}

export function paymentStatusLabel(status: PaymentStatusValue): string {
  return PAYMENT_STATUS[status].label;
}

export function PaymentStatusBadge({ status }: { status: PaymentStatusValue }) {
  const s = PAYMENT_STATUS[status];
  return <Badge variant="outline" className={TONE[s.tone]}>{s.label}</Badge>;
}

const METHOD_LABEL: Record<"cash" | "bank_transfer" | "online", string> = {
  cash: "Cash",
  bank_transfer: "Bank transfer",
  online: "Online",
};

export function methodLabel(method: "cash" | "bank_transfer" | "online"): string {
  return METHOD_LABEL[method];
}
