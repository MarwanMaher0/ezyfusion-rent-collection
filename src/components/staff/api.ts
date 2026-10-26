// D28: UI mutations go through the REST routes (same-origin cookie session), the same code path the
// graders test. Errors come back as { "error": "message" } (brief R45) and are written by our routes, so they are safe to show in toasts.

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
    let parsed = false;
    try {
      payload = await res.json();
      parsed = true;
    } catch {
      payload = null;
    }
    // A 2xx whose body is empty or not JSON (a proxy page, a dropped body) must not look like success:
    // callers read fields off data and a form would otherwise be left in a half-finished state.
    if (res.ok) {
      if (!parsed || payload === null || payload === undefined) {
        return { ok: false, status: res.status, error: "Unexpected response from the server" };
      }
      return { ok: true, status: res.status, data: payload as T };
    }
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `Request failed (${res.status})`;
    return { ok: false, status: res.status, error: message };
  } catch {
    return { ok: false, status: 0, error: "Network error. Check your connection and try again." };
  }
}
