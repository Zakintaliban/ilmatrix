import { promises as fs } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import config from "../config/env.js";
import {
  resolveMaterialPathSafe,
  isValidMaterialId,
} from "../utils/security.js";

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
 * Service for managing material files and content
 */
export class MaterialService {
  /**
   * Ensure uploads directory exists
   */
  async ensureUploadsDirectory(): Promise<void> {
    await fs.mkdir(config.uploadsDir, { recursive: true });
  }

  /**
   * Read material content by ID or return provided text
   */
  async readMaterial(
    materialId?: string,
    materialText?: string
  ): Promise<string> {
    if (materialText?.trim()) {
      return materialText;
    }

    if (!materialId) {
      throw new Error("materialId or materialText is required");
    }

    const pathResult = resolveMaterialPathSafe(materialId);
    if (!pathResult.ok) {
      throw new Error(pathResult.error || "Invalid material path");
    }

    try {
      return await fs.readFile(pathResult.path, "utf8");
    } catch (error) {
      if ((error as any)?.code === "ENOENT") {
        throw new Error("Material not found");
      }
      throw error;
    }
  }

  /**
   * Create new material with content
   */
  async createMaterial(content: string): Promise<string> {
    await this.ensureUploadsDirectory();

    const materialId = randomUUID();
    const pathResult = resolveMaterialPathSafe(materialId);

    if (!pathResult.ok) {
      throw new Error("Failed to create material path");
    }

    await fs.writeFile(pathResult.path, content.trim(), "utf8");
    return materialId;
  }

  /**
   * Append content to existing material
   */
  async appendToMaterial(materialId: string, content: string): Promise<void> {
    const pathResult = resolveMaterialPathSafe(materialId);
    if (!pathResult.ok) {
      throw new Error(pathResult.error || "Invalid material path");
    }

    let existingContent = "";
    try {
      existingContent = await fs.readFile(pathResult.path, "utf8");
    } catch (error) {
      if ((error as any)?.code === "ENOENT") {
        // File doesn't exist, create it
        existingContent = "";
      } else {
        throw error;
      }
    }

    const combinedContent = (existingContent + "\n" + content).trim();
    await fs.writeFile(pathResult.path, combinedContent, "utf8");
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
  async getMaterialInfo(materialId: string): Promise<MaterialInfo> {
    if (!isValidMaterialId(materialId)) {
      throw new Error("Invalid material ID");
    }

    const content = await this.readMaterial(materialId);
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
    fileName: string
  ): Promise<MaterialInfo> {
    if (!isValidMaterialId(materialId)) {
      throw new Error("Invalid material ID");
    }

    const pathResult = resolveMaterialPathSafe(materialId);
    if (!pathResult.ok) {
      throw new Error(pathResult.error || "Invalid material path");
    }

    const content = await fs.readFile(pathResult.path, "utf8");
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
    await fs.writeFile(pathResult.path, updatedContent, "utf8");

    return this.getMaterialInfo(materialId);
  }

  /**
   * Delete entire material
   */
  async deleteMaterial(materialId: string): Promise<void> {
    if (!isValidMaterialId(materialId)) {
      throw new Error("Invalid material ID");
    }

    const pathResult = resolveMaterialPathSafe(materialId);
    if (!pathResult.ok) {
      throw new Error(pathResult.error || "Invalid material path");
    }

    try {
      await fs.unlink(pathResult.path);
    } catch (error) {
      if ((error as any)?.code !== "ENOENT") {
        throw error;
      }
      // File doesn't exist, that's fine
    }
  }

  /**
   * Cleanup old materials based on TTL
   */
  async cleanupOldMaterials(): Promise<number> {
    try {
      await this.ensureUploadsDirectory();

      const ttlMs = config.materialTtlMinutes * 60_000;
      const cutoffTime = Date.now() - ttlMs;

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

// Export singleton instance
export const materialService = new MaterialService();
