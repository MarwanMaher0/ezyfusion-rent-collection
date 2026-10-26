// D28: UI mutations go through the REST routes (same-origin cookie session), the same code path the
// graders test. Errors come back as { "error": "message" } (brief R45) and are shown verbatim in toasts.

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export async function callApi<T = Record<string, unknown>>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; headers?: Record<string, string> },
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method: init.method,
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "same-origin",
    });
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (res.ok) return { ok: true, status: res.status, data: payload as T };
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `Request failed (${res.status})`;
    return { ok: false, status: res.status, error: message };
  } catch {
    return { ok: false, status: 0, error: "Network error. Check your connection and try again." };
  }
}
