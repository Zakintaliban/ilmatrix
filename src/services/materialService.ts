import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import config from "../config/env.js";
import { isValidMaterialId } from "../utils/security.js";
import { getMaterialStore } from "./materialStore.js";

export interface MaterialInfo {
  materialId: string;
  totalSize: number;
  files: {
    name: string;
    size: number;
    occurrences: number;
  }[];
}

export interface FileSegment {
  name: string;
  markerStart: number;
  contentStart: number;
  end: number;
}

/**
 * Service for managing material content. Storage (Postgres or local files)
 * lives in materialStore.ts; `userId` is the signed-in user making the
 * request, or null/undefined for guests.
 */
export class MaterialService {
  /**
   * Ensure uploads directory exists (used by the local-file store)
   */
  async ensureUploadsDirectory(): Promise<void> {
    await fs.mkdir(config.uploadsDir, { recursive: true });
  }

  /**
   * Read material content by ID or return provided text
   */
  async readMaterial(
    materialId?: string,
    materialText?: string,
    userId?: string | null
  ): Promise<string> {
    if (materialText?.trim()) {
      return materialText;
    }

    if (!materialId) {
      throw new Error("materialId or materialText is required");
    }

    const store = await getMaterialStore();
    return store.read(materialId, userId);
  }

  /**
   * Create new material with content
   */
  async createMaterial(content: string, userId?: string | null): Promise<string> {
    const materialId = randomUUID();
    const store = await getMaterialStore();
    await store.create(materialId, content.trim(), userId);
    return materialId;
  }

  /**
   * Append content to existing material
   */
  async appendToMaterial(
    materialId: string,
    content: string,
    userId?: string | null
  ): Promise<void> {
    const store = await getMaterialStore();
    await store.append(materialId, content, userId);
  }

  /**
   * Parse file segments from material content
   */
  parseFileSegments(content: string): FileSegment[] {
    const segments: FileSegment[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(/^===== FILE: (.+?) =====$/);

      if (match) {
        const name = match[1];
        const markerStart = content.indexOf(line);
        const contentStart = markerStart + line.length + 1;

        // Find the end of this segment (next marker or end of content)
        let end = content.length;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].match(/^===== FILE: .+? =====$/)) {
            end = content.indexOf(lines[j]);
            break;
          }
        }

        segments.push({
          name,
          markerStart,
          contentStart,
          end,
        });
      }
    }

    return segments;
  }

  /**
   * Get material information including file list
   */
  async getMaterialInfo(materialId: string, userId?: string | null): Promise<MaterialInfo> {
    if (!isValidMaterialId(materialId)) {
      throw new Error("Invalid material ID");
    }

    const content = await this.readMaterial(materialId, undefined, userId);
    const segments = this.parseFileSegments(content);

    // Group segments by filename and calculate stats
    const fileStats = new Map<string, { size: number; occurrences: number }>();

    for (const segment of segments) {
      const size = Math.max(0, segment.end - segment.contentStart);
      const existing = fileStats.get(segment.name) || {
        size: 0,
        occurrences: 0,
      };

      fileStats.set(segment.name, {
        size: existing.size + size,
        occurrences: existing.occurrences + 1,
      });
    }

    const files = Array.from(fileStats.entries()).map(([name, stats]) => ({
      name,
      size: stats.size,
      occurrences: stats.occurrences,
    }));

    const totalSize = Buffer.byteLength(content, "utf8");

    return {
      materialId,
      totalSize,
      files,
    };
  }

  /**
   * Remove specific file content from material
   */
  async removeFileFromMaterial(
    materialId: string,
    fileName: string,
    userId?: string | null
  ): Promise<MaterialInfo> {
    if (!isValidMaterialId(materialId)) {
      throw new Error("Invalid material ID");
    }

    const store = await getMaterialStore();
    const content = await store.read(materialId, userId);
    const segments = this.parseFileSegments(content);

    // Find segments to remove
    const removeRanges = segments
      .filter((s) => s.name === fileName)
      .sort((a, b) => a.markerStart - b.markerStart)
      .map((s) => ({ start: s.markerStart, end: s.end }));

    if (removeRanges.length === 0) {
      throw new Error(`File "${fileName}" not found in material`);
    }

    // Remove segments by rebuilding content
    const parts: string[] = [];
    let cursor = 0;

    for (const range of removeRanges) {
      if (cursor < range.start) {
        parts.push(content.slice(cursor, range.start));
      }
      cursor = range.end;
    }

    if (cursor < content.length) {
      parts.push(content.slice(cursor));
    }

    const updatedContent = parts.join("").trim();
    await store.replace(materialId, updatedContent, userId);

    return this.getMaterialInfo(materialId, userId);
  }

  /**
   * Delete entire material
   */
  async deleteMaterial(materialId: string, userId?: string | null): Promise<void> {
    if (!isValidMaterialId(materialId)) {
      throw new Error("Invalid material ID");
    }

    const store = await getMaterialStore();
    await store.delete(materialId, userId);
  }

  /**
   * Keep a material indefinitely (saved to the user's library)
   */
  async pinMaterial(materialId: string, userId: string): Promise<void> {
    const store = await getMaterialStore();
    await store.pin(materialId, userId);
  }

  /**
   * Return a material to normal retention (removed from the library)
   */
  async unpinMaterial(materialId: string, userId: string): Promise<void> {
    const store = await getMaterialStore();
    await store.unpin(materialId, userId);
  }

  /**
   * Delete materials whose retention has expired
   */
  async cleanupOldMaterials(): Promise<number> {
    try {
      const store = await getMaterialStore();
      return await store.cleanupExpired();
    } catch (error) {
      console.error("[MATERIALS] Cleanup failed:", error);
      return 0;
    }
  }
}

// Export singleton instance
export const materialService = new MaterialService();
