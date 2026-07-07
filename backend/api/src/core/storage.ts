import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, type Config } from "./config";

/**
 * Private object storage (BLUEPRINT §13) — Cloudflare R2 in production, a local
 * filesystem stub in dev/test. Same code path, config-selected (Phase 2
 * overriding principle: every third-party integration has a LOCAL STUB MODE).
 *
 * - REAL R2 when `R2_ACCOUNT_ID` + `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY`
 *   are all set: an S3-compatible client against `https://<account>.r2.
 *   cloudflarestorage.com`, bucket `config.R2_PRIVATE_BUCKET`, region "auto".
 * - STUB otherwise: bytes are written under `backend/api/.storage/private/<key>`
 *   (gitignored) and `presignPrivateGet` returns a syntactically valid,
 *   never-dereferenced URL `https://r2.local.invalid/private/<key>?stub=1&exp=<ts>`.
 *
 * Keys are ALWAYS caller-supplied (server-generated upstream — never from the
 * client), so there is no path-traversal surface here.
 *
 * Pinned cross-agent surface (consumed by Rx upload + invoice PDF):
 *   putPrivateObject(key, body, contentType): Promise<void>
 *   presignPrivateGet(key, ttlSec): Promise<string>   // z.url()-valid
 */

/** `backend/api/.storage/private` — resolved from this module (src/core/storage.ts). */
const STUB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".storage", "private");
/** Never resolvable — the stub URL is only ever inspected, not fetched. */
const STUB_HOST = "https://r2.local.invalid";

/** Real R2 is selected only when all three credential parts are present. */
function isRealR2(config: Config): boolean {
  return Boolean(
    config.R2_ACCOUNT_ID && config.R2_ACCESS_KEY_ID && config.R2_SECRET_ACCESS_KEY,
  );
}

/**
 * Lazily-built R2 handle: the (heavy) AWS SDK is dynamically imported only when
 * real credentials are configured, so stub-mode runs (dev/test) never load it.
 */
interface R2Handle {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  presign(key: string, ttlSec: number): Promise<string>;
}

let r2Promise: Promise<R2Handle> | null = null;

async function getR2(config: Config): Promise<R2Handle> {
  if (!r2Promise) {
    r2Promise = (async () => {
      const bucket = config.R2_PRIVATE_BUCKET;
      if (!bucket) {
        throw new Error(
          "R2_PRIVATE_BUCKET must be set when R2 credentials are configured (core/storage.ts).",
        );
      }
      const { S3Client, PutObjectCommand, GetObjectCommand } = await import("@aws-sdk/client-s3");
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
      const client = new S3Client({
        region: "auto",
        endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: config.R2_ACCESS_KEY_ID as string,
          secretAccessKey: config.R2_SECRET_ACCESS_KEY as string,
        },
      });
      return {
        async put(key, body, contentType) {
          await client.send(
            new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
          );
        },
        presign(key, ttlSec) {
          return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
            expiresIn: ttlSec,
          });
        },
      };
    })();
  }
  return r2Promise;
}

/** Store bytes at `key` on the private bucket. External I/O — never call inside a DB tx. */
export async function putPrivateObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const config = getConfig();
  if (isRealR2(config)) {
    const r2 = await getR2(config);
    await r2.put(key, body, contentType);
    return;
  }
  const filePath = join(STUB_ROOT, key);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, body);
}

/** Short-TTL presigned GET URL for `key`. z.url()-valid in both modes. */
export async function presignPrivateGet(key: string, ttlSec: number): Promise<string> {
  const config = getConfig();
  if (isRealR2(config)) {
    const r2 = await getR2(config);
    return r2.presign(key, ttlSec);
  }
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return `${STUB_HOST}/private/${key}?stub=1&exp=${exp}`;
}

/** Test-only: reset the memoised R2 handle (config changes between suites). */
export function resetStorageForTests(): void {
  r2Promise = null;
}
