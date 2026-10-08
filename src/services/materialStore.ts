import { promises as fs } from "fs";
import { join } from "path";
import config from "../config/env.js";
import { validateDatabaseConfig } from "../config/database.js";
import { query, transaction } from "./databaseService.js";
import { isValidMaterialId, resolveMaterialPathSafe } from "../utils/security.js";

/**
 * Where extracted material text lives.
 *
 * Postgres (`materials` table) is used whenever a database is configured and
 * migrated; otherwise materials fall back to `uploads/<id>.txt` files with
 * the old 60-minute TTL (local development and tests without a database).
 *
 * Access rules (Postgres):
 * - guest materials (no owner) are reachable by anyone holding the UUID;
 * - a signed-in user who uses a guest material claims it;
 * - owned materials are only visible to their owner.
 */
export interface MaterialStore {
  readonly kind: "postgres" | "file";
  read(id: string, userId?: string | null): Promise<string>;
  create(id: string, content: string, userId?: string | null): Promise<void>;
  append(id: string, content: string, userId?: string | null): Promise<void>;
  replace(id: string, content: string, userId?: string | null): Promise<void>;
  delete(id: string, userId?: string | null): Promise<void>;
  /** Keep forever (saved to the library). */
  pin(id: string, userId: string): Promise<void>;
  /** Back to normal retention (removed from the library). */
  unpin(id: string, userId: string): Promise<void>;
  /** Delete expired materials; returns how many were removed. */
  cleanupExpired(): Promise<number>;
}

export class MaterialNotFoundError extends Error {
  constructor() {
    super("Material not found");
    this.name = "MaterialNotFoundError";
  }
}

export class MaterialQuotaError extends Error {
  constructor(quotaBytes: number) {
    super(
      `Storage limit reached (${Math.round(quotaBytes / 1024 / 1024)}MB). Delete old materials to upload more.`
    );
    this.name = "MaterialQuotaError";
  }
}

function assertValidId(id: string): void {
  if (!isValidMaterialId(id)) {
    throw new Error("Invalid material ID format");
  }
}

// Postgres TEXT cannot hold NUL characters (some PDFs/text files contain them)
function sanitize(content: string): string {
  return content.replace(/\u0000/g, "");
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

const guestTtlSeconds = () => config.materialTtlMinutes * 60;
const userTtlSeconds = () => config.materialUserRetentionDays * 24 * 60 * 60;

/**
 * Shared SET/WHERE fragments. $1 = id, $2 = user id (or NULL),
 * $3 = guest TTL seconds, $4 = signed-in TTL seconds. In SET expressions
 * columns refer to the row before the update.
 */
const TOUCH_AND_CLAIM = `
  last_accessed_at = NOW(),
  user_id = COALESCE(user_id, $2::uuid),
  expires_at = CASE
    WHEN expires_at IS NULL THEN NULL
    WHEN COALESCE(user_id, $2::uuid) IS NULL THEN NOW() + make_interval(secs => $3)
    ELSE NOW() + make_interval(secs => $4)
  END`;

const ACCESSIBLE = `
  id = $1
  AND (expires_at IS NULL OR expires_at > NOW())
  AND (user_id IS NULL OR user_id = $2::uuid)`;

export class PostgresMaterialStore implements MaterialStore {
  readonly kind = "postgres" as const;

  async read(id: string, userId: string | null = null): Promise<string> {
    assertValidId(id);
    const result = await query<{ content: string }>(
      `UPDATE materials SET ${TOUCH_AND_CLAIM} WHERE ${ACCESSIBLE} RETURNING content`,
      [id, userId, guestTtlSeconds(), userTtlSeconds()]
    );
    if (!result.rows.length) throw new MaterialNotFoundError();
    return result.rows[0].content;
  }

  async create(id: string, content: string, userId: string | null = null): Promise<void> {
    assertValidId(id);
    const text = sanitize(content);
    if (userId) await this.assertWithinQuota(userId, Buffer.byteLength(text, "utf8"));
    await query(
      `INSERT INTO materials (id, user_id, content, expires_at)
       VALUES ($1, $2::uuid, $3, NOW() + make_interval(secs => $4))`,
      [id, userId, text, userId ? userTtlSeconds() : guestTtlSeconds()]
    );
  }

  async append(id: string, content: string, userId: string | null = null): Promise<void> {
    assertValidId(id);
    const text = sanitize(content);
    if (userId) await this.assertWithinQuota(userId, Buffer.byteLength(text, "utf8"));
    const result = await query(
      `UPDATE materials
       SET content = CASE WHEN content = '' THEN $5 ELSE content || E'\\n' || $5 END,
           updated_at = NOW(),
           ${TOUCH_AND_CLAIM}
       WHERE ${ACCESSIBLE}
       RETURNING id`,
      [id, userId, guestTtlSeconds(), userTtlSeconds(), text]
    );
    if (!result.rows.length) throw new MaterialNotFoundError();
  }

  async replace(id: string, content: string, userId: string | null = null): Promise<void> {
    assertValidId(id);
    const result = await query(
      `UPDATE materials SET content = $5, updated_at = NOW(), ${TOUCH_AND_CLAIM}
       WHERE ${ACCESSIBLE}
       RETURNING id`,
      [id, userId, guestTtlSeconds(), userTtlSeconds(), sanitize(content)]
    );
    if (!result.rows.length) throw new MaterialNotFoundError();
  }

  async delete(id: string, userId: string | null = null): Promise<void> {
    assertValidId(id);
    await transaction(async (client) => {
      await client.query(
        `DELETE FROM materials WHERE id = $1 AND (user_id IS NULL OR user_id = $2::uuid)`,
        [id, userId]
      );
      if (userId) {
        await client.query(`DELETE FROM user_materials WHERE material_id = $1 AND user_id = $2`, [id, userId]);
      }
    });
  }

  async pin(id: string, userId: string): Promise<void> {
    assertValidId(id);
    const result = await query(
      `UPDATE materials
       SET expires_at = NULL, user_id = COALESCE(user_id, $2::uuid), last_accessed_at = NOW()
       WHERE ${ACCESSIBLE}
       RETURNING id`,
      [id, userId]
    );
    if (!result.rows.length) throw new MaterialNotFoundError();
  }

  async unpin(id: string, userId: string): Promise<void> {
    assertValidId(id);
    await query(
      `UPDATE materials SET expires_at = NOW() + make_interval(secs => $3)
       WHERE id = $1 AND user_id = $2::uuid AND expires_at IS NULL`,
      [id, userId, userTtlSeconds()]
    );
  }

  async cleanupExpired(): Promise<number> {
    const result = await query(
      `DELETE FROM materials WHERE expires_at IS NOT NULL AND expires_at <= NOW()`
    );
    return result.rowCount;
  }

  private async assertWithinQuota(userId: string, addedBytes: number): Promise<void> {
    const result = await query<{ used: string }>(
      `SELECT COALESCE(SUM(size_bytes), 0) AS used FROM materials WHERE user_id = $1`,
      [userId]
    );
    if (Number(result.rows[0]?.used || 0) + addedBytes > config.materialUserQuotaBytes) {
      throw new MaterialQuotaError(config.materialUserQuotaBytes);
    }
  }
}

// ---------------------------------------------------------------------------
// Local files (no database)
// ---------------------------------------------------------------------------

export class FileMaterialStore implements MaterialStore {
  readonly kind = "file" as const;

  private path(id: string): string {
    const pathResult = resolveMaterialPathSafe(id);
    if (!pathResult.ok) {
      throw new Error(pathResult.error || "Invalid material path");
    }
    return pathResult.path;
  }

  async read(id: string): Promise<string> {
    try {
      return await fs.readFile(this.path(id), "utf8");
    } catch (error) {
      if ((error as any)?.code === "ENOENT") {
        throw new MaterialNotFoundError();
      }
      throw error;
    }
  }

  async create(id: string, content: string): Promise<void> {
    await fs.mkdir(config.uploadsDir, { recursive: true });
    await fs.writeFile(this.path(id), content, "utf8");
  }

  async append(id: string, content: string): Promise<void> {
    const filePath = this.path(id);
    let existingContent = "";
    try {
      existingContent = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as any)?.code !== "ENOENT") throw error;
      // File doesn't exist, create it
    }
    await fs.writeFile(filePath, (existingContent + "\n" + content).trim(), "utf8");
  }

  async replace(id: string, content: string): Promise<void> {
    await fs.writeFile(this.path(id), content, "utf8");
  }

  async delete(id: string): Promise<void> {
    try {
      await fs.unlink(this.path(id));
    } catch (error) {
      if ((error as any)?.code !== "ENOENT") throw error;
      // File doesn't exist, that's fine
    }
  }

  // Files have no owners or pinning; they always follow the TTL
  async pin(id: string): Promise<void> {
    await this.read(id);
  }

  async unpin(): Promise<void> {}

  async cleanupExpired(): Promise<number> {
    try {
      await fs.mkdir(config.uploadsDir, { recursive: true });

      const cutoffTime = Date.now() - config.materialTtlMinutes * 60_000;
      const files = await fs.readdir(config.uploadsDir).catch(() => []);
      let cleanedCount = 0;

      for (const fileName of files) {
        if (!fileName.endsWith(".txt")) continue;

        const filePath = join(config.uploadsDir, fileName);

        try {
          const stats = await fs.stat(filePath);
          const mtime = stats.mtime instanceof Date ? stats.mtime.getTime() : 0;

          if (mtime > 0 && mtime < cutoffTime) {
            await fs.unlink(filePath);
            cleanedCount++;
          }
        } catch {
          // Ignore individual file errors
        }
      }

      return cleanedCount;
    } catch {
      // Ignore cleanup errors
      return 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Store selection
// ---------------------------------------------------------------------------

let storePromise: Promise<MaterialStore> | null = null;

async function resolveStore(): Promise<MaterialStore> {
  if (!validateDatabaseConfig()) {
    return new FileMaterialStore();
  }
  const result = await query<{ table: string | null }>(`SELECT to_regclass('materials')::text AS table`);
  if (!result.rows[0]?.table) {
    console.warn(
      "[MATERIALS] Database has no materials table: run `npm run migrate run` and restart. " +
        "Using local files for now (materials will not persist)."
    );
    return new FileMaterialStore();
  }
  console.log("[MATERIALS] Using Postgres material storage");
  return new PostgresMaterialStore();
}

/** The active store, chosen on first use (a failed DB check is retried). */
export function getMaterialStore(): Promise<MaterialStore> {
  if (!storePromise) {
    storePromise = resolveStore().catch((error) => {
      storePromise = null;
      throw error;
    });
  }
  return storePromise;
}
