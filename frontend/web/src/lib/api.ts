import type { ErrorCode } from "@medrush/contracts";
import { API_BASE_URL } from "./env";
import { getFirebaseAuth, isFirebaseConfigured } from "./firebase";

/**
 * Typed API client for the ops/admin console. Every backend response is the
 * §7.1 envelope — `{ data, meta? }` on success, `{ error: { code, message } }`
 * on failure — so this wrapper unwraps `data`, surfaces `meta.nextCursor`, and
 * throws a typed {@link ApiError} the UI can switch on. Response types come
 * from `@medrush/contracts`; nothing here is hand-typed.
 */

/** Bearer token, held in module scope + mirrored to localStorage by the auth layer. */
let authToken: string | null = null;
export function setAuthToken(token: string | null): void {
  authToken = token;
}
/** Current bearer — read at call time (e.g. by the socket layer on reconnect). */
export function getAuthToken(): string | null {
  return authToken;
}

/**
 * Invoked when an authed request stays 401 after a forced token refresh — the
 * auth layer registers its `logout` here so the dead session is cleared.
 */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

/**
 * Firebase ID tokens expire hourly. Force-refresh via the SDK and update the
 * ambient bearer; returns null when unconfigured, signed out, or offline.
 */
async function forceRefreshedToken(): Promise<string | null> {
  if (typeof window === "undefined" || !isFirebaseConfigured) return null;
  try {
    const user = getFirebaseAuth().currentUser;
    if (!user) return null;
    const fresh = await user.getIdToken(true);
    authToken = fresh;
    return fresh;
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | "NETWORK" | "INTERNAL",
    message: string,
    readonly status: number,
    readonly details?: unknown,
    /** `x-request-id` echoed by the API — surfaced as a "Support code" in error UIs. */
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Toast-friendly rendering of a caught error: maps PAYMENT_UNAVAILABLE (503,
 * Razorpay outage/timeout) to a friendly retry message and appends the
 * `x-request-id` support code when the server echoed one, so a customer can
 * quote it to support and we can find the exact request in the logs.
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  const message =
    err.code === "PAYMENT_UNAVAILABLE"
      ? "Payments are temporarily unavailable — please try again in a minute"
      : err.message || fallback;
  return err.requestId ? `${message} · Support code: ${err.requestId}` : message;
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

async function request<T>(
  path: string,
  opts: RequestOptions = {},
  retried = false,
): Promise<Envelope<T>> {
  const token = opts.token !== undefined ? opts.token : authToken;
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

  const json = (await res.json().catch(() => null)) as
    | (Envelope<T> & { error?: { code: ErrorCode; message: string; details?: unknown } })
    | null;

  if (!res.ok || !json) {
    // Firebase mode: an ambient-token request that 401s likely hit the hourly
    // ID-token expiry — force-refresh once and retry. A second 401 (or no
    // refreshable session) means the session is truly dead: clear it via the
    // auth layer (same semantics as logout). Explicit-token requests (login
    // flows) are excluded — their callers own the error.
    if (res.status === 401 && isFirebaseConfigured && token && opts.token === undefined) {
      if (!retried) {
        const fresh = await forceRefreshedToken();
        if (fresh) return request<T>(path, opts, true);
      }
      onUnauthorized?.();
    }
    const error = json?.error;
    throw new ApiError(
      error?.code ?? "INTERNAL",
      error?.message ?? `Request failed (${res.status})`,
      res.status,
      error?.details,
      res.headers.get("x-request-id") ?? undefined,
    );
  }
  return json;
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
  const res = await fetch(`${API_BASE_URL}${path}`, {
    headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
    cache: "no-store",
  });
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
