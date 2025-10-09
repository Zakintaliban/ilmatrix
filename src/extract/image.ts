import Groq from "groq-sdk";
import config from "../config/env.js";
import { createLimiter, withTimeout } from "../utils/concurrency.js";

/**
 * Groq Vision API implementation for image text extraction
 * Uses Llama 4 Maverick multimodal models for OCR and image understanding
 */

const VISION_MODEL = "meta-llama/llama-4-maverick-17b-128e-instruct";
const VISION_CONCURRENCY = Math.max(1, config.groqConcurrency);
const visionLimiter = createLimiter(VISION_CONCURRENCY);

let groqClient: Groq | null = null;

function getGroqClient(): Groq {
  if (!config.groqApiKey) {
    throw new Error(
      "GROQ_API_KEY is required for image text extraction. Vision features are unavailable."
    );
  }
  if (!groqClient) {
    groqClient = new Groq({ apiKey: config.groqApiKey });
  }
  return groqClient;
}

/**
 * Extract text from image using Groq Vision API
 */
export function extractImageText(buffer: Buffer): Promise<string> {
  return visionLimiter(() => extractImageTextImpl(buffer));
}

async function extractImageTextImpl(buffer: Buffer): Promise<string> {
  try {
    const client = getGroqClient();

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

    // Call Groq Vision API with timeout
    const completion = await withTimeout(
      () =>
        client.chat.completions.create({
          model: VISION_MODEL,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Extract ALL text from this image. Return ONLY the extracted text with proper formatting and line breaks. Do not add any explanations, descriptions, or additional commentary. If the image contains tables, preserve the table structure using markdown format. If there is no text, return an empty response.",
                },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:${mimeType};base64,${base64Image}`,
                  },
                },
              ],
            },
          ],
          temperature: 0.1, // Low temperature for accurate OCR
          max_tokens: 4000, // Enough for most document text
        }),
      config.groqTimeoutMs,
      "Groq Vision API request timed out"
    );

    const extractedText = completion.choices?.[0]?.message?.content || "";
    return extractedText.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    
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
