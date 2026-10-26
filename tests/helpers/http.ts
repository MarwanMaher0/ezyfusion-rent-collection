import { env } from "./env";

export interface HttpResult<T = unknown> {
  status: number;
  /** Parsed JSON when the response is JSON, otherwise the raw text ("" for an empty body). */
  body: T;
  headers: Headers;
}

export interface RequestOpts {
  headers?: Record<string, string>;
}

async function read<T>(res: Response): Promise<HttpResult<T>> {
  const text = await res.text();
  let body: unknown = text;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body: body as T, headers: res.headers };
}

function url(p: string): string {
  return p.startsWith("http") ? p : `${env.baseUrl}${p.startsWith("/") ? "" : "/"}${p}`;
}

/**
 * HTTP client for the route handlers, authenticated with `Authorization: Bearer <token>` (R40).
 * `api()` without a token calls anonymously. Never follows redirects (a 307 to /login is a bug
 * for /api/** and must be visible as such).
 */
export function api(token?: string) {
  const base = (extra?: Record<string, string>): Record<string, string> => ({
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(extra ?? {}),
  });
  return {
    get<T = unknown>(path: string, opts: RequestOpts = {}): Promise<HttpResult<T>> {
      return fetch(url(path), { method: "GET", headers: base(opts.headers), redirect: "manual" }).then(read<T>);
    },
    /** JSON POST. A string `body` is sent verbatim (for malformed-JSON tests). */
    post<T = unknown>(path: string, body?: unknown, opts: RequestOpts = {}): Promise<HttpResult<T>> {
      const raw = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
      return fetch(url(path), {
        method: "POST",
        headers: base({ "content-type": "application/json", ...(opts.headers ?? {}) }),
        body: raw,
        redirect: "manual",
      }).then(read<T>);
    },
    /** Any method, for 405 / wrong-verb probes. */
    request<T = unknown>(method: string, path: string, body?: string, opts: RequestOpts = {}): Promise<HttpResult<T>> {
      return fetch(url(path), { method, headers: base(opts.headers), body, redirect: "manual" }).then(read<T>);
    },
  };
}

/**
 * application/x-www-form-urlencoded POST (the gateway webhook). `fields` is sent in the given
 * order; pass an array of pairs to send duplicate keys. No auth header (the gateway has none).
 */
export function postForm<T = unknown>(
  path: string,
  fields: Record<string, string> | Array<[string, string]>,
  opts: RequestOpts = {},
): Promise<HttpResult<T>> {
  const body = new URLSearchParams(fields as Record<string, string>).toString();
  return fetch(url(path), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(opts.headers ?? {}) },
    body,
    redirect: "manual",
  }).then(read<T>);
}
