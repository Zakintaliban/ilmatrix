import { resolve, join, sep } from "path";
import config from "../config/env.js";

/**
 * Validates UUID v4 format for material IDs
 */
export function isValidMaterialId(id?: string): boolean {
  if (!id) return false;
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
    id
  );
}

/**
 * Safely resolves material file path within uploads directory
 * Prevents path traversal attacks
 */
export function resolveMaterialPathSafe(id: string): {
  ok: boolean;
  path: string;
  error?: string;
} {
  if (!isValidMaterialId(id)) {
    return {
      ok: false,
      path: "",
      error: "Invalid material ID format",
    };
  }

  const root = resolve(config.uploadsDir);
  const materialPath = resolve(join(config.uploadsDir, `${id}.txt`));

  // Ensure the resolved path stays within uploadsDir
  if (!(materialPath.startsWith(root + sep) || materialPath === root)) {
    return {
      ok: false,
      path: materialPath,
      error: "Path traversal detected",
    };
  }

  return { ok: true, path: materialPath };
}

/**
 * Extracts client IP from request headers (handles proxies/load balancers)
 */
export function getClientIp(c: any): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    c.req.header("cf-connecting-ip") || // Cloudflare
    c.req.header("x-client-ip") ||
    (c.req.raw as any)?.socket?.remoteAddress ||
    "unknown"
  );
}

/**
 * Validates file type based on MIME type and extension
 */
export function isValidFileType(fileName: string, mimeType: string): boolean {
  const name = fileName.toLowerCase();
  const type = mimeType.toLowerCase();

  const validTypes = [
    // PDF
    { extensions: [".pdf"], mimeTypes: ["application/pdf"] },
    // Text
    { extensions: [".txt"], mimeTypes: ["text/plain"] },
    // Images
    { extensions: [".png"], mimeTypes: ["image/png"] },
    { extensions: [".jpg", ".jpeg"], mimeTypes: ["image/jpeg"] },
    // Office Documents
    {
      extensions: [".docx"],
      mimeTypes: [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ],
    },
    {
      extensions: [".pptx"],
      mimeTypes: [
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ],
    },
  ];

  return validTypes.some(({ extensions, mimeTypes }) => {
    const extensionMatch = extensions.some((ext) => name.endsWith(ext));
    const mimeMatch = mimeTypes.some((mime) => type.includes(mime));
    return extensionMatch || mimeMatch;
  });
}

/**
 * Sanitizes filename to prevent issues with file system operations
 */
export function sanitizeFileName(fileName: string): string {
  return fileName
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") // Replace invalid chars
    .replace(/^\.+/, "") // Remove leading dots
    .slice(0, 255); // Limit length
}

/**
 * Validates content length against limits
 */
export function validateContentLength(
  contentLength: number,
  maxSize: number = config.uploadMaxSizeBytes
): { valid: boolean; error?: string } {
  if (contentLength > maxSize) {
    return {
      valid: false,
      error: `Content size exceeds limit of ${Math.round(
        maxSize / 1024 / 1024
      )}MB`,
    };
  }
  return { valid: true };
}
