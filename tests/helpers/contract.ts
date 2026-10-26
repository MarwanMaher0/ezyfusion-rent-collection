import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { userClient } from "./clients";

// Zod schemas of the brief's HTTP contract (SPEC.md "Contracts" + "Error contract"), written from the
// SPEC, never imported from the app, so a drift in the app's DTOs fails the contract tests.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// D6: output instants are ISO 8601 in MYT with an explicit +08:00 offset.
const MYT_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?\+08:00$/;
const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const sen = z.number().int().nonnegative();

/** Every error body is exactly { error: string } (R45, D2). */
export const errorBody = z.object({ error: z.string().min(1) }).strict();

export const idBody = z.object({ id: z.string().uuid() }).strict();

export const paymentStatus = z.enum(["pending_verification", "approved", "rejected", "voided"]);
export const invoiceStatusEnum = z.enum(["paid", "partially_paid", "unpaid", "overdue"]);

export const recordPaymentBody = z.object({ id: z.string().uuid(), status: paymentStatus }).strict();
export const statusBody = z.object({ status: paymentStatus }).strict();

export const leaseDto = z
  .object({
    id: z.string().uuid(),
    unitId: z.string().uuid(),
    tenantId: z.string().uuid(),
    startDate: z.string().regex(ISO_DATE),
    endDate: z.string().regex(ISO_DATE),
    monthlyRentSen: z.number().int().positive(),
    depositSen: sen,
  })
  .strict();

export const invoiceDto = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(["deposit", "rent"]),
    periodIndex: z.number().int().nonnegative().nullable(),
    periodStart: z.string().regex(ISO_DATE).nullable(),
    periodEnd: z.string().regex(ISO_DATE).nullable(),
    dueDate: z.string().regex(ISO_DATE),
    amountSen: sen,
    paidSen: sen,
    status: invoiceStatusEnum,
  })
  .strict();

export const paymentDto = z
  .object({
    id: z.string().uuid(),
    amountSen: z.number().int().positive(),
    unappliedSen: sen,
    method: z.enum(["cash", "bank_transfer", "online"]),
    status: paymentStatus,
    receivedAt: z.string().regex(MYT_INSTANT),
  })
  .strict();

export const leaseDetail = z
  .object({ lease: leaseDto, invoices: z.array(invoiceDto), payments: z.array(paymentDto) })
  .strict();
export type LeaseDetailBody = z.infer<typeof leaseDetail>;

export const collectionsBody = z.array(
  z.object({ month: z.string().regex(YEAR_MONTH), collectedSen: sen }).strict(),
);

const SLIP_BUCKET = "payment-slips";
const SLIP_PDF = path.join(process.cwd(), "scripts", "assets", "slip-sample.pdf");

/**
 * Uploads a real PDF slip as the given staff/manager token (the UI's path, D22) to
 * `<orgId>/<leaseId>/<uuid>.pdf` and returns the object path. Throws if Storage refuses.
 */
export async function uploadSlip(token: string, orgId: string, leaseId: string): Promise<string> {
  const objectPath = `${orgId}/${leaseId}/${randomUUID()}.pdf`;
  const { error } = await userClient(token)
    .storage.from(SLIP_BUCKET)
    .upload(objectPath, readFileSync(SLIP_PDF), { contentType: "application/pdf", upsert: false });
  if (error) throw new Error(`uploadSlip(${objectPath}) failed: ${error.message}`);
  return objectPath;
}
