import { describe, expect, it } from "vitest";
import * as billing from "@/lib/billing";
import { formatSen, parseRinggitToSen, roundHalfUpDiv, toSen } from "@/lib/money";

describe("R48 D3 toSen: bigint/number -> safe integer number", () => {
  it.each([
    [BigInt(0), 0],
    [BigInt(5), 5],
    [BigInt(300000), 300000],
    [BigInt(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    [77419, 77419],
    [0, 0],
  ])("toSen(%s) = %d", (v, n) => {
    expect(toSen(v)).toBe(n);
  });

  it.each([
    BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1),
    BigInt("9223372036854775807"),
    BigInt("-1152921504606846976"),
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("throws on %s", (v) => {
    expect(() => toSen(v)).toThrow();
  });
});

describe("R49 formatSen: 'RM 1,500.00'", () => {
  it.each([
    [150000, "RM 1,500.00"],
    [77419, "RM 774.19"],
    [100029, "RM 1,000.29"],
    [5, "RM 0.05"],
    [50, "RM 0.50"],
    [0, "RM 0.00"],
    [99, "RM 0.99"],
    [100, "RM 1.00"],
    [100000000, "RM 1,000,000.00"],
    [12345678901, "RM 123,456,789.01"],
  ])("formatSen(%d) = %s", (sen, s) => {
    expect(formatSen(sen)).toBe(s);
  });

  it("round-trips through parseRinggitToSen for every sen value in a range", () => {
    const values = [0, 1, 9, 10, 99, 100, 101, 999, 1000, 99999, 100000, 100001, 123456789, 900000000001];
    for (let i = 0; i < 2000; i++) values.push(i * 37 + 3);
    for (const v of values) {
      expect(parseRinggitToSen(formatSen(v).replace(/^RM\s/, ""))).toBe(v);
    }
  });
});

describe("R10 R15 D4 money.ts re-exports the one rounding function and the one parser", () => {
  it("roundHalfUpDiv and parseRinggitToSen are the billing.ts functions themselves", () => {
    expect(roundHalfUpDiv).toBe(billing.roundHalfUpDiv);
    expect(parseRinggitToSen).toBe(billing.parseRinggitToSen);
  });
});
