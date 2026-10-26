import { afterEach, describe, expect, it } from "vitest";
import {
  addMonthsClamped,
  dateToIso,
  formatInstantMyt,
  formatMytDisplay,
  isYearMonth,
  mytLocalToIso,
  parseInstantWithOffset,
  toMytDate,
} from "@/lib/dates";
import * as billing from "@/lib/billing";
import { asOf } from "../helpers/time";

describe("R3 R52 formatInstantMyt: instants shown as Malaysia time with +08:00", () => {
  it.each([
    ["2026-01-31T02:00:00Z", "2026-01-31T10:00:00+08:00"], // seed cash payment
    ["2026-02-28T16:30:00Z", "2026-03-01T00:30:00+08:00"], // seed bank transfer (crosses the date)
    ["2026-03-01T16:00:00Z", "2026-03-02T00:00:00+08:00"],
    ["2026-12-31T16:30:00Z", "2027-01-01T00:30:00+08:00"], // crosses the year
    ["2028-02-28T20:00:00Z", "2028-02-29T04:00:00+08:00"], // leap day
    ["2026-03-08T07:30:00Z", "2026-03-08T15:30:00+08:00"], // New York DST start day
  ])("%s -> %s", (iso, myt) => {
    expect(formatInstantMyt(asOf(iso))).toBe(myt);
  });

  it("round-trips through parseInstantWithOffset to the same instant", () => {
    const d = asOf("2026-07-15T23:59:59Z");
    expect(parseInstantWithOffset(formatInstantMyt(d)).getTime()).toBe(d.getTime());
  });
});

describe("R45 D6 parseInstantWithOffset: ISO 8601 with an offset or Z only", () => {
  it.each([
    ["2026-01-31T10:00:00+08:00", "2026-01-31T02:00:00.000Z"],
    ["2026-01-31T02:00:00Z", "2026-01-31T02:00:00.000Z"],
    ["2026-01-31T02:00:00.000Z", "2026-01-31T02:00:00.000Z"],
    ["2026-01-30T21:00:00-05:00", "2026-01-31T02:00:00.000Z"],
    ["2026-03-01T00:30:00+08:00", "2026-02-28T16:30:00.000Z"],
  ])("accepts %s", (s, utc) => {
    expect(parseInstantWithOffset(s).toISOString()).toBe(utc);
  });

  it.each([
    "2026-01-31T10:00:00", // naive: would depend on the server zone
    "2026-01-31T10:00",
    "2026-01-31",
    "2026-01-31 10:00:00",
    "",
    "garbage",
    "1700000000000",
    "2026-13-01T00:00:00Z",
    "2026-02-30T10:00:00+08:00", // V8 silently rolls this over to Mar 2
    "2026-01-31T25:00:00Z",
  ])("throws on %j", (s) => {
    expect(() => parseInstantWithOffset(s)).toThrow();
  });
});

describe("R19 D26 mytLocalToIso: the UI's datetime-local is Malaysia time", () => {
  it("adds +08:00 and seconds", () => {
    expect(mytLocalToIso("2026-01-31T10:00")).toBe("2026-01-31T10:00:00+08:00");
    expect(mytLocalToIso("2026-03-01T00:30")).toBe("2026-03-01T00:30:00+08:00");
  });

  it("the result is the intended instant regardless of the machine zone", () => {
    expect(parseInstantWithOffset(mytLocalToIso("2026-03-01T00:30")).toISOString()).toBe("2026-02-28T16:30:00.000Z");
  });
});

describe("R48 dateToIso: Prisma @db.Date (UTC midnight) -> YYYY-MM-DD under every TZ", () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it.each(["UTC", "Asia/Kuala_Lumpur", "America/New_York", "Pacific/Pago_Pago", "Pacific/Kiritimati"])(
    "keeps the calendar date under TZ=%s",
    (tz) => {
      process.env.TZ = tz;
      expect(dateToIso(new Date(Date.UTC(2026, 0, 31)))).toBe("2026-01-31");
      expect(dateToIso(new Date(Date.UTC(2028, 1, 29)))).toBe("2028-02-29");
      expect(dateToIso(new Date(Date.UTC(2026, 2, 8)))).toBe("2026-03-08");
      expect(dateToIso(new Date(Date.UTC(2026, 11, 31)))).toBe("2026-12-31");
    },
  );
});

describe("R52 formatMytDisplay: human display in Malaysia time", () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it("matches the contract example under several TZs", () => {
    for (const tz of ["UTC", "America/New_York", "Asia/Kuala_Lumpur"]) {
      process.env.TZ = tz;
      expect(formatMytDisplay(asOf("2026-01-31T02:00:00Z")), tz).toBe("31 Jan 2026, 10:00");
      expect(formatMytDisplay(asOf("2026-02-28T16:30:00Z")), tz).toMatch(/^0?1 Mar 2026, 00:30$/);
    }
  });
});

describe("R29 isYearMonth", () => {
  it.each(["2026-01", "2026-12", "2028-02", "1999-07"])("accepts %s", (s) => {
    expect(isYearMonth(s)).toBe(true);
  });
  it.each(["2026-13", "2026-00", "2026-1", "26-01", "2026-01-01", "", " 2026-01", "2026/01", "2026-1a"])(
    "rejects %j",
    (s) => {
      expect(isYearMonth(s)).toBe(false);
    },
  );
});

describe("R3 R13 dates.ts re-exports the billing.ts date functions (one implementation)", () => {
  it("toMytDate and addMonthsClamped are the same functions as billing.ts", () => {
    expect(toMytDate).toBe(billing.toMytDate);
    expect(addMonthsClamped).toBe(billing.addMonthsClamped);
  });
});
