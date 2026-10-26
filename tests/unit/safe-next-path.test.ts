import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/components/app-shell/safe-next-path";

// Open-redirect guard for the login "next" parameter: anything that a browser could resolve to another
// origin (or that is not a plain path) must fall back to "/".
describe("R36 safeNextPath open-redirect guard", () => {
  const hostile: Array<[string, unknown]> = [
    ["protocol-relative", "//evil.com"],
    ["backslash host", "/\\evil.com"],
    ["tab between slashes (browsers strip it)", "/\t/evil.com"],
    ["newline between slashes (browsers strip it)", "/\n/evil.com"],
    ["absolute https URL", "https://evil.com"],
    ["javascript: URL", "javascript:alert(1)"],
    ["empty string", ""],
    ["undefined", undefined],
    ["null", null],
    ["array (repeated ?next=)", ["/a", "/b"]],
  ];

  it.each(hostile)("falls back to '/' for %s", (_name, input) => {
    expect(safeNextPath(input as string | null | undefined)).toBe("/");
  });

  it("never returns an off-origin target for an encoded double slash", () => {
    const out = safeNextPath("/%2F%2Fevil.com");
    // Nothing is decoded, so this is a literal same-origin path; falling back to "/" is also acceptable.
    expect(new URL(out, "http://local.invalid").origin).toBe("http://local.invalid");
    expect(out === "/" || out === "/%2F%2Fevil.com").toBe(true);
  });

  it("keeps legitimate same-origin paths unchanged", () => {
    expect(safeNextPath("/payments/return?bill_id=abc")).toBe("/payments/return?bill_id=abc");
    expect(safeNextPath("/leases")).toBe("/leases");
  });
});
