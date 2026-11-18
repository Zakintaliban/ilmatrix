import type { Context } from "hono";
import { materialService } from "../services/materialService.js";
import { extractionService } from "../services/extractionService.js";
import { validateContentLength } from "../utils/security.js";
import { MaterialQuotaError } from "../services/materialStore.js";
import { groqService } from "../services/groqService.js";
import { observeCost } from "../services/groqProvider.js";
import { reservationKredit } from "../services/quotaEstimates.js";
import { finishQuota, reserveQuota, updateTokenUsageAfterRequest } from "../middleware/tokenUsageMiddleware.js";
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

      // all: true keeps every value of repeated fields (the UI sends several "file" parts)
      const body = await c.req.parseBody({ all: true });
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

      const userId: string | null = c.get("user")?.id ?? null;

      // Image OCR uses the paid vision model and counts against signed-in users'
      // quotas. Without room (or if the quota can't be checked) images are kept
      // as images instead; the upload itself is never refused for quota.
      let ocr = true;
      let cost = { kredit: 0 };
      const images = files.filter((f: any) => extractionService.isImageFile(f.name || "", f.type || "")).length;
      if (userId && images > 0) {
        const reservation = await reserveQuota(c, userId, "ocr", reservationKredit("ocr", { images }));
        if (reservation instanceof Response) ocr = false;
        else cost = reservation.cost;
      }

      // Extract text from all files
      const { result: extractionResult, usage, model, kredit } = await observeCost(cost, () =>
        groqService.track(() => extractionService.extractFromFiles(files, { ocr }))
      );

      if (userId && usage) {
        await updateTokenUsageAfterRequest(c, usage.total_tokens, {
          model,
          kredit,
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          task: "ocr",
        });
      }

      // Handle material creation or appending
      let materialId: string;
      let wasAppended = false;

      if (doAppend && targetId) {
        try {
          await materialService.appendToMaterial(
            targetId,
            extractionResult.combinedContent,
            userId
          );
          materialId = targetId;
          wasAppended = true;
        } catch (error) {
          if (error instanceof MaterialQuotaError) throw error;
          // If append fails, create new material
          materialId = await materialService.createMaterial(
            extractionResult.combinedContent,
            userId
          );
          wasAppended = false;
        }
      } else {
        materialId = await materialService.createMaterial(
          extractionResult.combinedContent,
          userId
        );
        wasAppended = false;
      }

      // Get final material info
      const materialInfo = await materialService.getMaterialInfo(materialId, userId);

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
      return c.json({ error: message }, error instanceof MaterialQuotaError ? 413 : 400);
    } finally {
      // Settles an OCR reservation the success path didn't (errors, no text found)
      await finishQuota(c);
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
