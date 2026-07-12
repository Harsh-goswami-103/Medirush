import type { ErrorCode } from "@medrush/contracts";
import { API_BASE_URL } from "./env";

/**
 * Typed API client for the ops/admin console. Every backend response is the
 * §7.1 envelope — `{ data, meta? }` on success, `{ error: { code, message } }`
 * on failure — so this wrapper unwraps `data`, surfaces `meta.nextCursor`, and
 * throws a typed {@link ApiError} the UI can switch on. Response types come
 * from `@medrush/contracts`; nothing here is hand-typed.
 */

/** Bearer token (Firebase ID token, or a dev token in local builds), held in module scope by the auth layer. */
let authToken: string | null = null;
export function setAuthToken(token: string | null): void {
  authToken = token;
}
/** Current bearer — the socket handshake reads this at (re)connect time so it never captures a stale token. */
export function getAuthToken(): string | null {
  return authToken;
}

/**
 * Registered by the auth layer when Firebase is configured: force-refreshes the
 * ID token (they expire hourly) so a 401 mid-flight can be replayed once with a
 * fresh bearer. Returns null when nobody is signed in.
 */
let refreshAuthToken: (() => Promise<string | null>) | null = null;
export function setAuthTokenRefresher(fn: (() => Promise<string | null>) | null): void {
  refreshAuthToken = fn;
}

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | "NETWORK" | "INTERNAL",
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface Envelope<T> {
  data: T;
  meta?: { nextCursor?: string | null };
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Override the ambient token (e.g. during login before it is stored). */
  token?: string | null;
  signal?: AbortSignal;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<Envelope<T>> {
  const explicitToken = opts.token !== undefined;
  let token = explicitToken ? opts.token : authToken;
  let refreshed = false;

  for (;;) {
    let res: Response;
    try {
      res = await fetch(`${API_BASE_URL}${path}`, {
        method: opts.method ?? "GET",
        headers: {
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        cache: "no-store",
        signal: opts.signal,
      });
    } catch (err) {
      throw new ApiError("NETWORK", "Could not reach the server", 0, err);
    }

    // Firebase ID tokens rotate hourly — a 401 on the ambient token usually
    // means it just expired. Force one refresh and replay the request; explicit
    // per-call tokens (login-time /v1/me, /v1/auth/sync) are never replayed.
    if (res.status === 401 && !explicitToken && !refreshed && refreshAuthToken) {
      refreshed = true;
      const fresh = await refreshAuthToken().catch(() => null);
      if (fresh && fresh !== token) {
        token = fresh;
        continue;
      }
    }

    const json = (await res.json().catch(() => null)) as
      | (Envelope<T> & { error?: { code: ErrorCode; message: string; details?: unknown } })
      | null;

    if (!res.ok || !json) {
      const error = json?.error;
      throw new ApiError(
        error?.code ?? "INTERNAL",
        error?.message ?? `Request failed (${res.status})`,
        res.status,
        error?.details,
      );
    }
    return json;
  }
}

/** Query-string builder that drops undefined/empty values. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );
  if (entries.length === 0) return "";
  return "?" + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
}

/**
 * Fetch an authenticated file (e.g. a report `format=csv`) and trigger a browser
 * download — the endpoints require the bearer header, so a plain link won't do.
 */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const fetchWith = (bearer: string | null) =>
    fetch(`${API_BASE_URL}${path}`, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      cache: "no-store",
    });
  let res = await fetchWith(authToken);
  // Same expired-ID-token replay as request() — reports are long pages to lose.
  if (res.status === 401 && refreshAuthToken) {
    const fresh = await refreshAuthToken().catch(() => null);
    if (fresh) res = await fetchWith(fresh);
  }
  if (!res.ok) throw new ApiError("INTERNAL", `Download failed (${res.status})`, res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>(path, { ...opts, method: "GET" }),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: "POST", body }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: "PATCH", body }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: "PUT", body }),
  del: <T>(path: string, opts?: RequestOptions) => request<T>(path, { ...opts, method: "DELETE" }),
};
