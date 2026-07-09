import { APP_VERSION_HEADER, IDEMPOTENCY_KEY_HEADER, type ErrorCode } from "@medrush/contracts";
import { API_BASE_URL, APP_VERSION } from "./env";

/**
 * Typed API client for the driver app. Every backend response is the §7.1
 * envelope — `{ data, meta? }` on success, `{ error: { code, message } }` on
 * failure — so this unwraps `data` and throws a typed {@link ApiError}. Response
 * types come from `@medrush/contracts`; nothing here is hand-typed.
 *
 * Driver-specific: every `/v1/driver/*` route is gated on `x-app-version`
 * (426 UPGRADE_REQUIRED below the floor), so the header is attached automatically.
 */

/** Bearer token, held in module scope + mirrored to AsyncStorage by the auth layer. */
let authToken: string | null = null;
export function setAuthToken(token: string | null): void {
  authToken = token;
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
  /** POST /driver/payouts requires a client-generated idempotency key. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<Envelope<T>> {
  const token = opts.token !== undefined ? opts.token : authToken;
  const headers: Record<string, string> = {
    // The backend floors `/v1/driver/*` on the app version.
    [APP_VERSION_HEADER]: APP_VERSION,
  };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.idempotencyKey) headers[IDEMPOTENCY_KEY_HEADER] = opts.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    throw new ApiError("NETWORK", "Could not reach the server", 0, err);
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

/** Query-string builder that drops undefined/empty values. */
export function qs(
  params: Record<string, string | number | boolean | undefined | null>,
): string {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );
  if (entries.length === 0) return "";
  return "?" + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
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
