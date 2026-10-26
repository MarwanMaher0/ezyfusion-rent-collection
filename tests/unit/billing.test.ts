import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addMonthsClamped,
  generateSchedule,
  invoiceStatus,
  parseRinggitToSen,
  roundHalfUpDiv,
  toMytDate,
  type ScheduledInvoice,
} from "@/lib/billing";
import { asOf, mytAt } from "../helpers/time";

// Expected values are computed by hand from the brief (§3), never from the implementation.

const deposit = (dueDate: string, amountSen: number): ScheduledInvoice => ({
  kind: "deposit",
  periodIndex: null,
  periodStart: null,
  periodEnd: null,
  dueDate,
  amountSen,
});
const rent = (periodIndex: number, periodStart: string, periodEnd: string, amountSen: number): ScheduledInvoice => ({
  kind: "rent",
  periodIndex,
  periodStart,
  periodEnd,
  dueDate: periodStart,
  amountSen,
});

/** Day after a YYYY-MM-DD, computed independently of the implementation (UTC parts only). */
function nextDay(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day + 1)).toISOString().slice(0, 10);
}

describe("R10 billing.ts is pure and self-contained", () => {
  const src = readFileSync(path.join(process.cwd(), "src/lib/billing.ts"), "utf8");
  // Strip comments so an explanatory comment never trips the checks.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("has no import, re-export-from, dynamic import or require", () => {
    expect(code).not.toMatch(/^\s*import[\s{*'"]/m);
    expect(code).not.toMatch(/^\s*export\s[^;]*\sfrom\s+['"]/m);
    expect(code).not.toMatch(/\bimport\s*\(/);
    expect(code).not.toMatch(/\brequire\s*\(/);
  });

  it("never reads the wall clock or the machine timezone", () => {
    expect(code).not.toMatch(/Date\.now\s*\(/);
    expect(code).not.toMatch(/new Date\(\s*\)/);
    expect(code).not.toMatch(/\.get(FullYear|Month|Date|Day|Hours|Minutes|Seconds|TimezoneOffset)\s*\(/);
    expect(code).not.toMatch(/toLocale(Date|Time)?String|Intl\./);
    expect(code).not.toMatch(/\b(process|fetch|globalThis|window|document)\b/);
  });
});

describe("R12 R13 R14 R15 R16 generateSchedule: brief worked example (Aisyah)", () => {
  it("matches the table exactly, every field", () => {
    expect(
      generateSchedule({ startDate: "2026-01-31", endDate: "2026-07-15", monthlyRentSen: 150000, depositSen: 300000 }),
    ).toStrictEqual([
      deposit("2026-01-31", 300000),
      rent(0, "2026-01-31", "2026-02-27", 150000),
      rent(1, "2026-02-28", "2026-03-30", 150000),
      rent(2, "2026-03-31", "2026-04-29", 150000),
      rent(3, "2026-04-30", "2026-05-30", 150000),
      rent(4, "2026-05-31", "2026-06-29", 150000),
      rent(5, "2026-06-30", "2026-07-15", 77419), // 150000 x 16 / 31 = 77419.35
    ]);
  });
});

describe("R12 R14 R15 generateSchedule: seeded leases", () => {
  it("Ben: no deposit, last period 15/30 days of 100029 = 50014.5 -> 50015 (half up)", () => {
    expect(
      generateSchedule({ startDate: "2026-01-01", endDate: "2026-04-15", monthlyRentSen: 100029, depositSen: 0 }),
    ).toStrictEqual([
      rent(0, "2026-01-01", "2026-01-31", 100029),
      rent(1, "2026-02-01", "2026-02-28", 100029),
      rent(2, "2026-03-01", "2026-03-31", 100029),
      rent(3, "2026-04-01", "2026-04-15", 50015),
    ]);
  });

  it("Probe: 2026-02-28..2027-02-27 -> deposit + 12 full periods anchored on the 28th", () => {
    const s = generateSchedule({ startDate: "2026-02-28", endDate: "2027-02-27", monthlyRentSen: 200000, depositSen: 400000 });
    const anchors = [
      "2026-02-28", "2026-03-28", "2026-04-28", "2026-05-28", "2026-06-28", "2026-07-28",
      "2026-08-28", "2026-09-28", "2026-10-28", "2026-11-28", "2026-12-28", "2027-01-28",
    ];
    const ends = [
      "2026-03-27", "2026-04-27", "2026-05-27", "2026-06-27", "2026-07-27", "2026-08-27",
      "2026-09-27", "2026-10-27", "2026-11-27", "2026-12-27", "2027-01-27", "2027-02-27",
    ];
    expect(s).toStrictEqual([deposit("2026-02-28", 400000), ...anchors.map((a, k) => rent(k, a, ends[k], 200000))]);
  });

  it("Chen: 2026-03-15..2027-03-14 -> deposit + 12 full periods on the 15th", () => {
    const s = generateSchedule({ startDate: "2026-03-15", endDate: "2027-03-14", monthlyRentSen: 220000, depositSen: 440000 });
    expect(s).toHaveLength(13);
    expect(s[0]).toStrictEqual(deposit("2026-03-15", 440000));
    expect(s[1]).toStrictEqual(rent(0, "2026-03-15", "2026-04-14", 220000));
    expect(s[10]).toStrictEqual(rent(9, "2026-12-15", "2027-01-14", 220000));
    expect(s[12]).toStrictEqual(rent(11, "2027-02-15", "2027-03-14", 220000));
    expect(s.slice(1).every((i) => i.amountSen === 220000)).toBe(true);
  });
});

describe("R12 generateSchedule: deposit rule", () => {
  it("depositSen 0 -> no deposit invoice at all", () => {
    const s = generateSchedule({ startDate: "2026-05-10", endDate: "2026-06-09", monthlyRentSen: 1000, depositSen: 0 });
    expect(s).toStrictEqual([rent(0, "2026-05-10", "2026-06-09", 1000)]);
  });

  it("depositSen 1 -> deposit of 1 sen first, due on startDate, period fields null", () => {
    const s = generateSchedule({ startDate: "2026-05-10", endDate: "2026-06-09", monthlyRentSen: 1000, depositSen: 1 });
    expect(s[0]).toStrictEqual(deposit("2026-05-10", 1));
    expect(s).toHaveLength(2);
  });
});

describe("R14 R15 generateSchedule: period boundaries", () => {
  it("start == end -> one 1-day period prorated over the full 31-day period", () => {
    // 2026-03-10..2026-04-09 is 31 days; 100000 x 1 / 31 = 3225.8 -> 3226
    expect(
      generateSchedule({ startDate: "2026-03-10", endDate: "2026-03-10", monthlyRentSen: 100000, depositSen: 0 }),
    ).toStrictEqual([rent(0, "2026-03-10", "2026-03-10", 3226)]);
  });

  it("end exactly on an anchor -> an extra 1-day period", () => {
    // anchors 01-15, 02-15, 03-15 (= end); period 2 is 03-15..04-14 (31 days), 1 used
    expect(
      generateSchedule({ startDate: "2026-01-15", endDate: "2026-03-15", monthlyRentSen: 100000, depositSen: 0 }),
    ).toStrictEqual([
      rent(0, "2026-01-15", "2026-02-14", 100000),
      rent(1, "2026-02-15", "2026-03-14", 100000),
      rent(2, "2026-03-15", "2026-03-15", 3226),
    ]);
  });

  it("end = next anchor - 1 day -> last period is full price, no extra period", () => {
    expect(
      generateSchedule({ startDate: "2026-01-15", endDate: "2026-03-14", monthlyRentSen: 100000, depositSen: 0 }),
    ).toStrictEqual([rent(0, "2026-01-15", "2026-02-14", 100000), rent(1, "2026-02-15", "2026-03-14", 100000)]);
  });

  it("proration divides by the PERIOD length (anchor to anchor), not the calendar month", () => {
    // Jan 31 start: period 0 is 01-31..02-27 = 28 days; end 02-10 uses 11 -> 280000 x 11 / 28 = 110000
    expect(
      generateSchedule({ startDate: "2026-01-31", endDate: "2026-02-10", monthlyRentSen: 280000, depositSen: 0 }),
    ).toStrictEqual([rent(0, "2026-01-31", "2026-02-10", 110000)]);
  });

  it("28-, 29-, 30- and 31-day full periods are each used as the divisor", () => {
    const last = (startDate: string, endDate: string, monthlyRentSen: number) =>
      generateSchedule({ startDate, endDate, monthlyRentSen, depositSen: 0 }).at(-1)!;
    expect(last("2026-01-01", "2026-02-14", 280000)).toStrictEqual(rent(1, "2026-02-01", "2026-02-14", 140000)); // 14/28
    expect(last("2028-01-01", "2028-02-14", 280000)).toStrictEqual(rent(1, "2028-02-01", "2028-02-14", 135172)); // 14/29 = 135172.4
    expect(last("2026-03-01", "2026-04-10", 300000)).toStrictEqual(rent(1, "2026-04-01", "2026-04-10", 100000)); // 10/30
    expect(last("2026-04-01", "2026-05-10", 310000)).toStrictEqual(rent(1, "2026-05-01", "2026-05-10", 100000)); // 10/31
  });

  it("a period exists for every anchor <= endDate, and none after", () => {
    const s = generateSchedule({ startDate: "2026-01-31", endDate: "2026-02-28", monthlyRentSen: 100000, depositSen: 0 });
    // anchor 1 = 2026-02-28 = end -> 1-day period 2; 2026-02-28..2026-03-30 is 31 days -> 3226
    expect(s).toStrictEqual([rent(0, "2026-01-31", "2026-02-27", 100000), rent(1, "2026-02-28", "2026-02-28", 3226)]);
  });
});

describe("R13 generateSchedule: anchors from the start date, clamped, never drifting", () => {
  it("Jan 31 in a leap year (2028): Feb 29, then back to Mar 31, Apr 30, May 31", () => {
    const s = generateSchedule({ startDate: "2028-01-31", endDate: "2028-05-31", monthlyRentSen: 300000, depositSen: 0 });
    expect(s).toStrictEqual([
      rent(0, "2028-01-31", "2028-02-28", 300000),
      rent(1, "2028-02-29", "2028-03-30", 300000),
      rent(2, "2028-03-31", "2028-04-29", 300000),
      rent(3, "2028-04-30", "2028-05-30", 300000),
      rent(4, "2028-05-31", "2028-05-31", 10000), // 05-31..06-29 = 30 days, 1 used
    ]);
  });

  it("start 2028-02-29 anchors on the 29th, Feb 28 in 2029, then back to Mar 29 (no drift)", () => {
    const s = generateSchedule({ startDate: "2028-02-29", endDate: "2029-04-30", monthlyRentSen: 100000, depositSen: 0 });
    expect(s.map((i) => i.dueDate)).toStrictEqual([
      "2028-02-29", "2028-03-29", "2028-04-29", "2028-05-29", "2028-06-29", "2028-07-29", "2028-08-29",
      "2028-09-29", "2028-10-29", "2028-11-29", "2028-12-29", "2029-01-29", "2029-02-28", "2029-03-29",
      "2029-04-29",
    ]);
    expect(s[12]).toStrictEqual(rent(12, "2029-02-28", "2029-03-28", 100000));
    // last: 04-29..05-28 is 30 days, 2 used -> 100000 x 2 / 30 = 6666.7 -> 6667
    expect(s[14]).toStrictEqual(rent(14, "2029-04-29", "2029-04-30", 6667));
  });

  it("Jan 31 over two years: clamps every short month and always returns to the 31st", () => {
    const s = generateSchedule({ startDate: "2026-01-31", endDate: "2028-03-30", monthlyRentSen: 100000, depositSen: 0 });
    const due = s.map((i) => i.dueDate);
    expect(due.slice(0, 13)).toStrictEqual([
      "2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30", "2026-07-31",
      "2026-08-31", "2026-09-30", "2026-10-31", "2026-11-30", "2026-12-31", "2027-01-31",
    ]);
    expect(due).toContain("2027-02-28");
    expect(due).toContain("2028-02-29");
    expect(due.at(-1)).toBe("2028-02-29"); // 2028-03-31 > end
    expect(s.at(-1)!.periodEnd).toBe("2028-03-30");
    expect(s.at(-1)!.amountSen).toBe(100000); // 02-29..03-30 is the full period
  });

  it("addMonthsClamped counts from the start date", () => {
    expect(addMonthsClamped("2026-01-31", 0)).toBe("2026-01-31");
    expect(addMonthsClamped("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsClamped("2026-01-31", 2)).toBe("2026-03-31");
    expect(addMonthsClamped("2026-01-31", 3)).toBe("2026-04-30");
    expect(addMonthsClamped("2026-01-31", 11)).toBe("2026-12-31");
    expect(addMonthsClamped("2026-01-31", 13)).toBe("2027-02-28");
    expect(addMonthsClamped("2026-01-31", 25)).toBe("2028-02-29");
    expect(addMonthsClamped("2026-01-30", 1)).toBe("2026-02-28");
    expect(addMonthsClamped("2028-02-29", 12)).toBe("2029-02-28");
    expect(addMonthsClamped("2028-02-29", 48)).toBe("2032-02-29");
    expect(addMonthsClamped("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonthsClamped("2099-12-31", 2)).toBe("2100-02-28"); // 2100 is not a leap year
  });
});

describe("R16 generateSchedule: order and shape invariants", () => {
  const leases = [
    { startDate: "2026-01-31", endDate: "2026-07-15", monthlyRentSen: 150000, depositSen: 300000 },
    { startDate: "2026-01-01", endDate: "2026-04-15", monthlyRentSen: 100029, depositSen: 0 },
    { startDate: "2026-02-28", endDate: "2027-02-27", monthlyRentSen: 200000, depositSen: 400000 },
    { startDate: "2028-02-29", endDate: "2031-03-01", monthlyRentSen: 123457, depositSen: 7 },
    { startDate: "2026-12-31", endDate: "2027-12-30", monthlyRentSen: 99, depositSen: 0 },
    { startDate: "2026-08-31", endDate: "2026-09-29", monthlyRentSen: 100000, depositSen: 5 },
  ];

  it.each(leases)("deposit first, indexes 0..n-1, contiguous periods covering start..end ($startDate..$endDate)", (l) => {
    const s = generateSchedule(l);
    const rents = s.filter((i) => i.kind === "rent");
    if (l.depositSen > 0) {
      expect(s[0]).toStrictEqual(deposit(l.startDate, l.depositSen));
      expect(s.filter((i) => i.kind === "deposit")).toHaveLength(1);
    } else {
      expect(s.some((i) => i.kind === "deposit")).toBe(false);
    }
    expect(s.slice(l.depositSen > 0 ? 1 : 0)).toStrictEqual(rents);
    expect(rents.map((i) => i.periodIndex)).toStrictEqual(rents.map((_, k) => k));
    expect(rents[0].periodStart).toBe(l.startDate);
    expect(rents.at(-1)!.periodEnd).toBe(l.endDate);
    for (let k = 0; k < rents.length; k++) {
      expect(rents[k].dueDate).toBe(rents[k].periodStart);
      expect(rents[k].periodStart! <= rents[k].periodEnd!).toBe(true);
      expect(rents[k].periodStart).toBe(addMonthsClamped(l.startDate, k));
      if (k > 0) expect(rents[k].periodStart).toBe(nextDay(rents[k - 1].periodEnd!));
      if (k < rents.length - 1) expect(rents[k].amountSen).toBe(l.monthlyRentSen);
      expect(Number.isSafeInteger(rents[k].amountSen)).toBe(true);
      expect(rents[k].amountSen).toBeGreaterThan(0);
      expect(rents[k].amountSen).toBeLessThanOrEqual(l.monthlyRentSen);
    }
  });

  it("returns a fresh array each call (no shared mutable state)", () => {
    const a = generateSchedule(leases[0]);
    a[0].amountSen = 1;
    a.pop();
    expect(generateSchedule(leases[0])).toHaveLength(7);
    expect(generateSchedule(leases[0])[0].amountSen).toBe(300000);
  });
});

describe("R15 rounding: half up to the sen, rounded once", () => {
  it("exactly .5 rounds up (Ben 50014.5 -> 50015; 1 sen x 15/30 = 0.5 -> 1; 3 x 15/30 = 1.5 -> 2)", () => {
    expect(roundHalfUpDiv(100029 * 15, 30)).toBe(50015);
    expect(roundHalfUpDiv(1 * 15, 30)).toBe(1);
    expect(roundHalfUpDiv(3 * 15, 30)).toBe(2);
    expect(roundHalfUpDiv(5, 2)).toBe(3);
    expect(roundHalfUpDiv(1, 2)).toBe(1);
    const s = generateSchedule({ startDate: "2026-04-01", endDate: "2026-04-15", monthlyRentSen: 3, depositSen: 0 });
    expect(s).toStrictEqual([rent(0, "2026-04-01", "2026-04-15", 2)]);
  });

  it("below .5 rounds down, above .5 rounds up", () => {
    expect(roundHalfUpDiv(150000 * 16, 31)).toBe(77419); // .35
    expect(roundHalfUpDiv(100000 * 1, 31)).toBe(3226); // .806
    expect(roundHalfUpDiv(1, 3)).toBe(0);
    expect(roundHalfUpDiv(2, 3)).toBe(1);
    expect(roundHalfUpDiv(49, 100)).toBe(0);
    expect(roundHalfUpDiv(50, 100)).toBe(1);
    expect(roundHalfUpDiv(149, 100)).toBe(1);
    expect(roundHalfUpDiv(150, 100)).toBe(2);
    expect(roundHalfUpDiv(0, 31)).toBe(0);
    expect(roundHalfUpDiv(62, 31)).toBe(2);
  });

  it("is exact for large rents (no float drift): RM 9,000,000,000.01 x 15/30 = ...000.5 -> up", () => {
    expect(roundHalfUpDiv(900000000001 * 15, 30)).toBe(450000000001);
    const s = generateSchedule({ startDate: "2026-04-01", endDate: "2026-04-15", monthlyRentSen: 900000000001, depositSen: 0 });
    expect(s[0].amountSen).toBe(450000000001);
    const t = generateSchedule({ startDate: "2026-07-01", endDate: "2026-07-16", monthlyRentSen: 900000000000, depositSen: 0 });
    expect(t[0].amountSen).toBe(464516129032); // 900000000000 x 16 / 31 = 464516129032.26
  });

  it("int4-sized and odd rents prorate by integer arithmetic", () => {
    // 2147483647 x 16 / 31 = 1108378656.516 -> 1108378657
    const s = generateSchedule({ startDate: "2026-07-01", endDate: "2026-07-16", monthlyRentSen: 2147483647, depositSen: 0 });
    expect(s[0].amountSen).toBe(1108378657);
    // 2147483647 x 15 / 30 = 1073741823.5 -> 1073741824
    const t = generateSchedule({ startDate: "2026-04-01", endDate: "2026-04-15", monthlyRentSen: 2147483647, depositSen: 0 });
    expect(t[0].amountSen).toBe(1073741824);
  });
});

describe("R11 generateSchedule: validation throws", () => {
  const ok = { startDate: "2026-01-31", endDate: "2026-07-15", monthlyRentSen: 150000, depositSen: 300000 };

  it("accepts the valid baseline", () => {
    expect(() => generateSchedule(ok)).not.toThrow();
  });

  it.each([
    "2026-02-30", "2026-02-29", "2100-02-29", "2026-04-31", "2026-13-01", "2026-00-10", "2026-01-00", "2026-01-32",
    "2026-1-05", "2026-01-5", "26-01-05", "2026/01/05", "20260105", "2026-01-31T00:00", "2026-01-31T00:00:00Z",
    " 2026-01-31", "2026-01-31 ", "", "abcd-ef-gh", "+2026-01-31", "02026-01-31",
  ])("throws on startDate %j", (bad) => {
    expect(() => generateSchedule({ ...ok, startDate: bad, endDate: "2026-12-31" })).toThrow(Error);
  });

  it.each(["2026-02-30", "2026-1-05", "2026-07-15T00:00", "", "2027-02-29"])("throws on endDate %j", (bad) => {
    expect(() => generateSchedule({ ...ok, endDate: bad })).toThrow(Error);
  });

  it("accepts real leap days", () => {
    expect(() => generateSchedule({ ...ok, startDate: "2028-02-29", endDate: "2028-03-01" })).not.toThrow();
    expect(() => generateSchedule({ ...ok, startDate: "2000-02-29", endDate: "2000-03-01" })).not.toThrow();
  });

  it("throws when endDate is before startDate (by one day, across months, across years)", () => {
    expect(() => generateSchedule({ ...ok, startDate: "2026-03-10", endDate: "2026-03-09" })).toThrow(Error);
    expect(() => generateSchedule({ ...ok, startDate: "2026-03-01", endDate: "2026-02-28" })).toThrow(Error);
    expect(() => generateSchedule({ ...ok, startDate: "2027-01-01", endDate: "2026-12-31" })).toThrow(Error);
  });

  it.each([0, -1, 1.5, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.5])(
    "throws on monthlyRentSen %s",
    (bad) => {
      expect(() => generateSchedule({ ...ok, monthlyRentSen: bad })).toThrow(Error);
    },
  );

  it.each([-1, 1.5, 0.5, Number.NaN, Number.POSITIVE_INFINITY, -0.0001])("throws on depositSen %s", (bad) => {
    expect(() => generateSchedule({ ...ok, depositSen: bad })).toThrow(Error);
  });

  it("throws on non-number amounts that would coerce ('1000', null, undefined)", () => {
    for (const bad of ["1000", null, undefined, true]) {
      expect(() => generateSchedule({ ...ok, monthlyRentSen: bad as unknown as number })).toThrow(Error);
      expect(() => generateSchedule({ ...ok, depositSen: bad as unknown as number })).toThrow(Error);
    }
  });

  it("throws on non-string dates (a Date object, a number)", () => {
    expect(() => generateSchedule({ ...ok, startDate: new Date("2026-01-31T00:00:00Z") as unknown as string })).toThrow(Error);
    expect(() => generateSchedule({ ...ok, endDate: 20260715 as unknown as string })).toThrow(Error);
  });
});

describe("R17 invoiceStatus: rule order and the Malaysia-midnight boundary", () => {
  const due = "2026-03-01";
  const before = asOf("2026-03-01T15:59:59.999Z"); // 23:59:59.999 MYT on the due date
  const after = asOf("2026-03-01T16:00:00Z"); // 00:00 MYT the day after

  it("due 2026-03-01: not overdue at 15:59:59.999Z, overdue at exactly 16:00:00Z", () => {
    expect(invoiceStatus({ dueDate: due, amountSen: 1000, paidSen: 0 }, before)).toBe("unpaid");
    expect(invoiceStatus({ dueDate: due, amountSen: 1000, paidSen: 0 }, after)).toBe("overdue");
    expect(after.getTime() - before.getTime()).toBe(1);
  });

  it("all four statuses", () => {
    expect(invoiceStatus({ dueDate: due, amountSen: 1000, paidSen: 1000 }, after)).toBe("paid");
    expect(invoiceStatus({ dueDate: due, amountSen: 1000, paidSen: 1 }, after)).toBe("overdue");
    expect(invoiceStatus({ dueDate: due, amountSen: 1000, paidSen: 999 }, before)).toBe("partially_paid");
    expect(invoiceStatus({ dueDate: due, amountSen: 1000, paidSen: 0 }, before)).toBe("unpaid");
  });

  it("paid beats overdue; overpaid is paid; a partially paid invoice can be overdue", () => {
    expect(invoiceStatus({ dueDate: "2020-01-01", amountSen: 1000, paidSen: 1000 }, after)).toBe("paid");
    expect(invoiceStatus({ dueDate: "2020-01-01", amountSen: 1000, paidSen: 5000 }, after)).toBe("paid");
    expect(invoiceStatus({ dueDate: due, amountSen: 1000, paidSen: 999 }, after)).toBe("overdue");
  });

  it("due today (any time of the MYT day) is not overdue; due in the future is not overdue", () => {
    expect(invoiceStatus({ dueDate: due, amountSen: 1000, paidSen: 0 }, mytAt("2026-03-01", "00:00"))).toBe("unpaid");
    expect(invoiceStatus({ dueDate: due, amountSen: 1000, paidSen: 0 }, mytAt("2026-03-01", "23:30"))).toBe("unpaid");
    expect(invoiceStatus({ dueDate: "2027-01-01", amountSen: 1000, paidSen: 10 }, after)).toBe("partially_paid");
  });

  it("uses the Malaysia date, not the UTC date or the caller's local date", () => {
    // 23:30 UTC on Mar 1 is 07:30 MYT on Mar 2 -> overdue although the UTC date is still Mar 1
    expect(invoiceStatus({ dueDate: due, amountSen: 1000, paidSen: 0 }, asOf("2026-03-01T23:30:00Z"))).toBe("overdue");
    // 20:00 in New York on Mar 1 is 09:00 MYT on Mar 2
    expect(invoiceStatus({ dueDate: due, amountSen: 1000, paidSen: 0 }, asOf("2026-03-01T20:00:00-05:00"))).toBe("overdue");
    // 23:30 MYT on Mar 1 is still Mar 1 in Malaysia (15:30Z)
    expect(invoiceStatus({ dueDate: due, amountSen: 1000, paidSen: 0 }, asOf("2026-03-01T23:30:00+08:00"))).toBe("unpaid");
    // 11:00 in New York on Feb 28 (EST) is 16:00Z = 00:00 MYT Mar 1 -> a Feb 28 invoice is overdue
    expect(invoiceStatus({ dueDate: "2026-02-28", amountSen: 1000, paidSen: 0 }, asOf("2026-02-28T11:00:00-05:00"))).toBe("overdue");
    expect(invoiceStatus({ dueDate: "2026-02-28", amountSen: 1000, paidSen: 0 }, asOf("2026-02-28T10:59:59-05:00"))).toBe("unpaid");
  });

  it("America/New_York DST days do not move the boundary (MYT has no DST)", () => {
    // spring forward 2026-03-08, fall back 2026-11-01 in New York; boundary is still 16:00Z
    for (const d of ["2026-03-08", "2026-11-01"]) {
      const prev = new Date(Date.parse(`${d}T16:00:00Z`) - 1);
      expect(invoiceStatus({ dueDate: d, amountSen: 1000, paidSen: 0 }, prev)).toBe("unpaid");
      expect(invoiceStatus({ dueDate: d, amountSen: 1000, paidSen: 0 }, asOf(`${d}T16:00:00Z`))).toBe("overdue");
      expect(invoiceStatus({ dueDate: d, amountSen: 1000, paidSen: 0 }, asOf(`${d}T07:30:00Z`))).toBe("unpaid");
    }
  });

  it("leap day and year-end boundaries", () => {
    expect(invoiceStatus({ dueDate: "2028-02-29", amountSen: 5, paidSen: 0 }, asOf("2028-02-29T15:59:59.999Z"))).toBe("unpaid");
    expect(invoiceStatus({ dueDate: "2028-02-29", amountSen: 5, paidSen: 0 }, asOf("2028-02-29T16:00:00Z"))).toBe("overdue");
    expect(invoiceStatus({ dueDate: "2026-12-31", amountSen: 5, paidSen: 2 }, asOf("2026-12-31T15:59:59Z"))).toBe("partially_paid");
    expect(invoiceStatus({ dueDate: "2026-12-31", amountSen: 5, paidSen: 2 }, asOf("2026-12-31T16:00:00Z"))).toBe("overdue");
  });

  it("toMytDate gives the Malaysia calendar date of an instant", () => {
    expect(toMytDate(asOf("2026-03-01T15:59:59.999Z"))).toBe("2026-03-01");
    expect(toMytDate(asOf("2026-03-01T16:00:00Z"))).toBe("2026-03-02");
    expect(toMytDate(asOf("2026-12-31T16:00:00Z"))).toBe("2027-01-01");
    expect(toMytDate(asOf("2028-02-28T16:00:00Z"))).toBe("2028-02-29");
  });
});

describe("R10 R13 R17 results are identical under any process timezone", () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it("schedule and statuses do not change when TZ changes at runtime", () => {
    const lease = { startDate: "2026-01-31", endDate: "2026-07-15", monthlyRentSen: 150000, depositSen: 300000 };
    const probe = () => ({
      schedule: generateSchedule(lease),
      ny: generateSchedule({ startDate: "2026-03-08", endDate: "2026-11-01", monthlyRentSen: 100029, depositSen: 0 }),
      s1: invoiceStatus({ dueDate: "2026-03-01", amountSen: 10, paidSen: 0 }, asOf("2026-03-01T15:59:59.999Z")),
      s2: invoiceStatus({ dueDate: "2026-03-01", amountSen: 10, paidSen: 0 }, asOf("2026-03-01T16:00:00Z")),
      today: toMytDate(asOf("2026-03-08T07:00:00Z")),
      anchor: addMonthsClamped("2026-01-31", 1),
    });
    // Guard: the runtime TZ switch must really take effect in this worker, or the test proves nothing.
    process.env.TZ = "America/New_York";
    expect(new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset()).toBe(300);
    process.env.TZ = "UTC";
    expect(new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset()).toBe(0);
    const baseline = probe();
    for (const tz of ["Asia/Kuala_Lumpur", "America/New_York", "Pacific/Kiritimati", "Pacific/Pago_Pago", "Europe/London"]) {
      process.env.TZ = tz;
      expect(probe(), tz).toStrictEqual(baseline);
    }
    expect(baseline.s1).toBe("unpaid");
    expect(baseline.s2).toBe("overdue");
  });
});

describe("R18 parseRinggitToSen", () => {
  it.each([
    ["1,500.50", 150050],
    ["1.15", 115],
    ["7", 700],
    [" 1,500 ", 150000],
    ["1.1", 110],
    ["0", 0],
    ["0.05", 5],
    ["1,000,000.00", 100000000],
    ["1500", 150000],
    ["1,500", 150000],
    ["1,234,567.89", 123456789],
    ["999", 99900],
    ["\t12.3\n", 1230],
    ["0.29", 29], // float trap: 0.29 * 100 = 28.999...
    ["4.35", 435], // float trap: 4.35 * 100 = 434.999...
    ["1000.29", 100029], // Ben's rent; 1000.29 * 100 = 100028.999...
    ["1,000.29", 100029],
    ["2,200.00", 220000],
    ["0.10", 10],
    ["100,000", 10000000],
  ])("accepts %j -> %d", (input, sen) => {
    const v = parseRinggitToSen(input);
    expect(v).toBe(sen);
    expect(Number.isSafeInteger(v)).toBe(true);
  });

  it.each([
    "", "   ", "-5", "1.234", "1e3", "RM 10", "1,23", "1,500.", ".5", "+5", "1 500", "1,5000", "12,34,567",
    "NaN", "Infinity", "1,", ",100", "1.", "0x10", "1,500,50", "1.2.3", "1_000", "10.005", "-0", "1,000.5.0",
    "５", "1.5e2", "RM10", "10 sen", "1,000,00", "1234,567", "1.-5", "--5", "1..5", "1,,000",
  ])("throws on %j", (input) => {
    expect(() => parseRinggitToSen(input)).toThrow(Error);
  });

  it("never returns an unsafe integer for a huge input (throws instead)", () => {
    let v: number | undefined;
    try {
      v = parseRinggitToSen("99999999999999999999.99");
    } catch {
      v = undefined;
    }
    if (v !== undefined) expect(Number.isSafeInteger(v)).toBe(true);
  });
});
