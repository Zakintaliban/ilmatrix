import { groqService } from "../services/groqService.js";

/**
 * Groq Vision implementation for image text extraction.
 * The vision model is configured by GROQ_VISION_MODEL (see config/env.ts);
 * concurrency, timeouts and fallbacks are handled by the Groq provider.
 */

/**
 * Extract text from image using Groq Vision API
 */
export async function extractImageText(buffer: Buffer): Promise<string> {
  try {
    // Convert buffer to base64
    const base64Image = buffer.toString("base64");

    // Detect image type from buffer header
    const imageType = detectImageType(buffer);
    const mimeType = imageType === "png" ? "image/png" : "image/jpeg";

    // Check size limit for base64 encoding (4MB max)
    const base64Size = Buffer.byteLength(base64Image, "utf8");
    if (base64Size > 4 * 1024 * 1024) {
      return ""; // Return empty to trigger base64 storage
    }

    return await groqService.extractTextFromImage(`data:${mimeType};base64,${base64Image}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[OCR] Image text extraction failed: ${message}`);
    return ""; // Return empty string to trigger base64 storage
  }
}

/**
 * Detect image type from buffer header
 */
function detectImageType(buffer: Buffer): "png" | "jpeg" {
  // PNG signature: 89 50 4E 47
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "png";
  }

  // JPEG signature: FF D8 FF
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }

  // Default to jpeg
  return "jpeg";
}
