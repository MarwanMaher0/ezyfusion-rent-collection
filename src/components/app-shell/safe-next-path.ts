const BASE = "http://local.invalid";

// R36 open-redirect guard: only a same-origin path is accepted; anything else falls back to "/".
// Nothing is decoded. Control characters are rejected because browsers strip tabs/newlines inside URLs
// ("/\t/evil.com" would become "//evil.com"); "//" and "/\" read as another host. The URL check is the
// final authority: the target must still resolve to our own origin.
export function safeNextPath(next: unknown): string {
  if (typeof next !== "string" || !next.startsWith("/")) return "/";
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return "/";
  try {
    if (new URL(next, BASE).origin !== BASE) return "/";
  } catch {
    return "/";
  }
  return next;
}
