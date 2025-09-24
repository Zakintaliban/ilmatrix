import type { Context } from "hono";
import { materialService } from "../services/materialService.js";
import { extractionService } from "../services/extractionService.js";
import { validateContentLength } from "../utils/security.js";
import config from "../config/env.js";

export class UploadController {
  /**
   * Handle file upload and text extraction
   */
  async handleUpload(c: Context) {
    try {
      await materialService.ensureUploadsDirectory();

      // Early guard by Content-Length
      const contentLength = Number(c.req.header("content-length") || 0);
      const validation = validateContentLength(
        contentLength,
        config.uploadMaxSizeBytes + 2 * 1024 * 1024
      ); // Allow extra for multipart overhead

      if (!validation.valid) {
        return c.json({ error: validation.error }, 413);
      }

      const body = await c.req.parseBody();
      const files = this.extractFilesFromBody(body);

      if (!files.length) {
        return c.json(
          {
            error:
              'Provide multipart/form-data with one or more "file" fields (PDF/TXT/PNG/JPG/DOCX/PPTX)',
          },
          400
        );
      }

      // Parse flags for append/merge behavior
      const { doAppend, targetId } = this.parseUploadFlags(body);

      // Extract text from all files
      const extractionResult = await extractionService.extractFromFiles(files);

      // Handle material creation or appending
      let materialId: string;
      let wasAppended = false;

      if (doAppend && targetId) {
        try {
          await materialService.appendToMaterial(
            targetId,
            extractionResult.combinedContent
          );
          materialId = targetId;
          wasAppended = true;
        } catch (error) {
          // If append fails, create new material
          materialId = await materialService.createMaterial(
            extractionResult.combinedContent
          );
          wasAppended = false;
        }
      } else {
        materialId = await materialService.createMaterial(
          extractionResult.combinedContent
        );
        wasAppended = false;
      }

      // Get final material info
      const materialInfo = await materialService.getMaterialInfo(materialId);

      return c.json({
        materialId,
        appended: wasAppended,
        files: extractionResult.files.length,
        size: materialInfo.totalSize,
        sizeAdded: extractionResult.totalSize,
        limit: `${Math.round(config.uploadMaxSizeBytes / 1024 / 1024)}MB`,
        extractedFiles: extractionResult.files.map((f) => ({
          name: f.name,
          type: f.type,
          size: f.size,
        })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 400);
    }
  }

  /**
   * Extract files from multipart form body
   */
  private extractFilesFromBody(body: any): any[] {
    const files: any[] = [];

    for (const [, value] of Object.entries(body)) {
      const addIfFile = (item: any) => {
        if (item && typeof item.arrayBuffer === "function") {
          files.push(item);
        }
      };

      if (Array.isArray(value)) {
        value.forEach(addIfFile);
      } else {
        addIfFile(value);
      }
    }

    return files;
  }

  /**
   * Parse upload flags for append/merge behavior
   */
  private parseUploadFlags(body: any): { doAppend: boolean; targetId: string } {
    const getScalar = (value: any) => (Array.isArray(value) ? value[0] : value);

    const appendRaw = getScalar(body.append);
    const mergeToRaw = getScalar(body.mergeTo) || getScalar(body.materialId);

    const doAppend =
      typeof appendRaw === "string"
        ? /^(true|1|yes|on)$/i.test(appendRaw)
        : !!appendRaw;

    const targetId = doAppend ? String(mergeToRaw || "") : "";

    return { doAppend, targetId };
  }
}

export const uploadController = new UploadController();
