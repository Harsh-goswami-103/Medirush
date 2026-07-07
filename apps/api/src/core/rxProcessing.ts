import {
  RX_ALLOWED_MIME_TYPES,
  RX_MAX_UPLOAD_BYTES,
  type RxAllowedMimeType,
} from "@medrush/contracts";
import { AppError } from "./errors";

/**
 * Prescription upload validation + normalisation (BLUEPRINT §10.1, §13; phase-2
 * brief §5). Defends the private bucket against spoofed / oversized / malicious
 * uploads:
 *
 * - size ≤ RX_MAX_UPLOAD_BYTES (5 MB);
 * - the declared MIME must be in the allowlist AND the leading bytes must match a
 *   real jpeg / png / pdf signature (a `.exe` renamed `.png` is rejected);
 * - images are re-encoded via sharp, which drops all metadata — stripping EXIF /
 *   GPS that could leak a patient's location;
 * - PDFs pass through unchanged after the header check (no JS/rasterising).
 *
 * Throws `AppError("VALIDATION_ERROR", …, 422)` on any violation. The heavy
 * `sharp` dependency is imported lazily so non-image paths never load it.
 *
 * Pinned cross-agent signature (prescriptions/routes):
 *   validateAndNormalizeUpload(buf, mime):
 *     Promise<{ ext: "jpg"|"png"|"pdf"; body: Buffer; contentType: string }>
 */

export type RxExt = "jpg" | "png" | "pdf";

export interface NormalizedUpload {
  ext: RxExt;
  body: Buffer;
  contentType: string;
}

/** Detected content type from leading magic bytes — null when unrecognised. */
type SniffedType = "image/jpeg" | "image/png" | "application/pdf" | null;

function sniff(buf: Buffer): SniffedType {
  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }
  // PDF: 25 50 44 46 2D ("%PDF-")
  if (
    buf.length >= 5 &&
    buf[0] === 0x25 &&
    buf[1] === 0x50 &&
    buf[2] === 0x44 &&
    buf[3] === 0x46 &&
    buf[4] === 0x2d
  ) {
    return "application/pdf";
  }
  return null;
}

function reject(message: string): never {
  throw new AppError("VALIDATION_ERROR", message, 422);
}

export async function validateAndNormalizeUpload(
  buf: Buffer,
  mime: string,
): Promise<NormalizedUpload> {
  if (buf.length === 0) reject("The uploaded file is empty");
  if (buf.length > RX_MAX_UPLOAD_BYTES) {
    reject(`File exceeds the ${Math.floor(RX_MAX_UPLOAD_BYTES / (1024 * 1024))}MB limit`);
  }
  if (!(RX_ALLOWED_MIME_TYPES as readonly string[]).includes(mime)) {
    reject("Only JPEG, PNG or PDF prescriptions are accepted");
  }

  const detected = sniff(buf);
  if (detected === null) {
    reject("File content does not match a supported image or PDF format");
  }

  if (detected === "application/pdf") {
    // Pass through after the header check — never rasterised or executed.
    return { ext: "pdf", body: buf, contentType: "application/pdf" };
  }

  // Image: re-encode to bake EXIF orientation then drop ALL metadata (§10.1).
  const { default: sharp } = await import("sharp");
  const pipeline = sharp(buf, { failOn: "error" }).rotate();
  if (detected === "image/png") {
    const body = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    return { ext: "png", body, contentType: "image/png" };
  }
  const body = await pipeline.jpeg({ quality: 85, mozjpeg: false }).toBuffer();
  return { ext: "jpg", body, contentType: "image/jpeg" };
}

/** Narrowing helper for callers that want the declared MIME typed. */
export function isAllowedRxMime(mime: string): mime is RxAllowedMimeType {
  return (RX_ALLOWED_MIME_TYPES as readonly string[]).includes(mime);
}
