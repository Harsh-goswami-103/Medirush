import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
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

/**
 * Outbound-call deadlines (§10): the SDK's node handler is UNBOUNDED by default,
 * so a hung R2 endpoint would pin Rx uploads/invoice writes open forever. Plain
 * NodeHttpHandler options object — the SDK builds the handler itself (do not
 * import @smithy/node-http-handler; it is not a direct dependency).
 */
const S3_REQUEST_HANDLER = { connectionTimeout: 3_000, requestTimeout: 10_000 };

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
        requestHandler: S3_REQUEST_HANDLER,
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

/* ------------------------------------------------------------- backups */

/**
 * Backup object storage (Phase 7 §24). Same stub/real posture as above, but
 * scoped HARD to the `backups/` prefix and pointed at an OPTIONALLY dedicated
 * bucket + credentials (`BACKUP_R2_*`, each falling back to the runtime R2
 * value) — a compromised runtime API key must not be able to destroy backups.
 */

/** Keys handled by the backup helpers must live under this prefix. */
export const BACKUPS_PREFIX = "backups/";

export interface BackupObject {
  key: string;
  /** Upload time (R2 LastModified / stub file mtime). */
  lastModified: Date;
  size: number;
}

/** Effective backup destination: `BACKUP_R2_*` overrides, runtime R2 fallback. */
function backupR2Config(config: Config): {
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket?: string;
} {
  return {
    accountId: config.BACKUP_R2_ACCOUNT_ID ?? config.R2_ACCOUNT_ID,
    accessKeyId: config.BACKUP_R2_ACCESS_KEY_ID ?? config.R2_ACCESS_KEY_ID,
    secretAccessKey: config.BACKUP_R2_SECRET_ACCESS_KEY ?? config.R2_SECRET_ACCESS_KEY,
    bucket: config.BACKUP_R2_BUCKET ?? config.R2_PRIVATE_BUCKET,
  };
}

/** Real backup R2 is selected only when all three effective credential parts exist. */
export function isRealBackupR2(config: Config): boolean {
  const eff = backupR2Config(config);
  return Boolean(eff.accountId && eff.accessKeyId && eff.secretAccessKey);
}

interface BackupR2Handle {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  list(prefix: string): Promise<BackupObject[]>;
  delete(key: string): Promise<void>;
}

let backupR2Promise: Promise<BackupR2Handle> | null = null;

async function getBackupR2(config: Config): Promise<BackupR2Handle> {
  if (!backupR2Promise) {
    backupR2Promise = (async () => {
      const eff = backupR2Config(config);
      const bucket = eff.bucket;
      if (!bucket) {
        throw new Error(
          "BACKUP_R2_BUCKET or R2_PRIVATE_BUCKET must be set when backup R2 credentials are configured (core/storage.ts).",
        );
      }
      const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } =
        await import("@aws-sdk/client-s3");
      const client = new S3Client({
        region: "auto",
        endpoint: `https://${eff.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: eff.accessKeyId as string,
          secretAccessKey: eff.secretAccessKey as string,
        },
        requestHandler: S3_REQUEST_HANDLER,
      });
      return {
        async put(key, body, contentType) {
          await client.send(
            new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
          );
        },
        async list(prefix) {
          const objects: BackupObject[] = [];
          let continuationToken: string | undefined;
          do {
            const page = await client.send(
              new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                ContinuationToken: continuationToken,
              }),
            );
            for (const obj of page.Contents ?? []) {
              if (!obj.Key) continue;
              objects.push({
                key: obj.Key,
                lastModified: obj.LastModified ?? new Date(0),
                size: obj.Size ?? 0,
              });
            }
            continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
          } while (continuationToken);
          return objects;
        },
        async delete(key) {
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        },
      };
    })();
  }
  return backupR2Promise;
}

function assertBackupKey(key: string): void {
  if (!key.startsWith(BACKUPS_PREFIX) || key.includes("..")) {
    throw new Error(`backup storage keys must live under "${BACKUPS_PREFIX}" (got "${key}")`);
  }
}

/** Store backup bytes at `key` (must be under `backups/`). External I/O — never inside a DB tx. */
export async function putBackupObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  assertBackupKey(key);
  const config = getConfig();
  if (isRealBackupR2(config)) {
    const r2 = await getBackupR2(config);
    await r2.put(key, body, contentType);
    return;
  }
  const filePath = join(STUB_ROOT, key);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, body);
}

/** List every object under the `backups/` prefix (newest and oldest alike). */
export async function listBackupObjects(): Promise<BackupObject[]> {
  const config = getConfig();
  if (isRealBackupR2(config)) {
    const r2 = await getBackupR2(config);
    return r2.list(BACKUPS_PREFIX);
  }
  const dir = join(STUB_ROOT, BACKUPS_PREFIX);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // no backups written yet
  }
  const objects: BackupObject[] = [];
  for (const name of names) {
    const info = await stat(join(dir, name));
    if (!info.isFile()) continue;
    objects.push({ key: `${BACKUPS_PREFIX}${name}`, lastModified: info.mtime, size: info.size });
  }
  return objects;
}

/** Delete one backup object. Refuses keys outside the `backups/` prefix. */
export async function deleteBackupObject(key: string): Promise<void> {
  assertBackupKey(key);
  const config = getConfig();
  if (isRealBackupR2(config)) {
    const r2 = await getBackupR2(config);
    await r2.delete(key);
    return;
  }
  await unlink(join(STUB_ROOT, key));
}

/** Test-only: reset the memoised R2 handles (config changes between suites). */
export function resetStorageForTests(): void {
  r2Promise = null;
  backupR2Promise = null;
}
