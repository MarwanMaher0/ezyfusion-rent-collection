// Deterministic instants for tests: never the wall clock, never the machine timezone.

/** An instant from an ISO string that MUST carry Z or an offset (a naive string would depend on TZ). */
export function asOf(isoWithOffset: string): Date {
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(isoWithOffset)) {
    throw new Error(`asOf needs an explicit offset or Z: ${isoWithOffset}`);
  }
  const d = new Date(isoWithOffset);
  if (Number.isNaN(d.getTime())) throw new Error(`asOf: invalid instant ${isoWithOffset}`);
  return d;
}

/** The instant of a Malaysia wall-clock time: mytAt("2026-03-02", "00:00") = 2026-03-01T16:00:00Z. */
export function mytAt(date: string, time = "00:00:00"): Date {
  const t = time.length === 5 ? `${time}:00` : time;
  return asOf(`${date}T${t}+08:00`);
}

/** Midnight Malaysia time at the start of `date` (first instant of that MYT day). */
export function mytMidnight(date: string): Date {
  return mytAt(date, "00:00:00");
}

/** The last millisecond of `date` in Malaysia time. */
export function mytEndOfDay(date: string): Date {
  return asOf(`${date}T23:59:59.999+08:00`);
}
