import { extractPdfText } from "../extract/pdf.js";
import { extractImageText } from "../extract/image.js";
import { extractDocxText } from "../extract/docx.js";
import { extractPptxText } from "../extract/pptx.js";
import { isValidFileType, sanitizeFileName } from "../utils/security.js";
import { createLimiter } from "../utils/concurrency.js";
import config from "../config/env.js";

export interface ExtractedFile {
  name: string;
  content: string;
  size: number;
  type: string;
}

export interface ExtractionResult {
  files: ExtractedFile[];
  totalSize: number;
  combinedContent: string;
}

/**
 * Service for extracting text content from various file formats
 */
export class ExtractionService {
  private readonly extractionLimiter = createLimiter(3); // Limit concurrent extractions

  /**
   * Extract text from uploaded file. With `ocr: false`, images are stored for
   * later visual analysis without calling the (paid) vision model.
   */
  async extractFromFile(file: any, options: { ocr?: boolean } = {}): Promise<ExtractedFile> {
    const ocr = options.ocr !== false;
    const name = sanitizeFileName(file.name || "unknown");
    const type = file.type || "";
    const buffer = Buffer.from(await file.arrayBuffer());

    return this.extractionLimiter(async () => {
      let content = "";

      try {
        if (this.isPdfFile(name, type)) {
          content = await extractPdfText(buffer);
        } else if (this.isImageFile(name, type)) {
          // Text in the image (OCR), for tools that can't see images
          let text = "";
          try {
            text = ocr ? (await extractImageText(buffer)).trim() : "";
          } catch (error) {
            text = ""; // OCR failed: the image alone is kept
          }
          if (/^(no (extractable )?text|there is no text|nothing|empty)\b/i.test(text)) text = "";

          // The image is always kept as well: a diagram, chart or photo loses its meaning as text,
          // so chat and explanations send the picture itself to the vision model
          const base64 = buffer.toString("base64");
          const imageType = this.detectImageType(buffer);
          const mimeType = imageType === "png" ? "image/png" : "image/jpeg";

          content = `${text ? `${text}\n\n` : ""}[IMAGE: ${name}]
Type: ${mimeType}
Size: ${Math.round(buffer.length / 1024)}KB
Encoding: base64
Note: ${text ? "The text above was read from this image." : "This image has no extractable text."} Image data is preserved for visual analysis.

Base64 Data:
data:${mimeType};base64,${base64}

Vision API can analyze this image when queried.`;
        } else if (this.isDocxFile(name, type)) {
          content = await extractDocxText(buffer);
        } else if (this.isPptxFile(name, type)) {
          content = await extractPptxText(buffer);
        } else if (this.isTextFile(name, type)) {
          content = buffer.toString("utf8");
        } else {
          throw new Error(
            `Unsupported file type for "${name}". Supported: PDF, TXT, PNG/JPG, DOCX, PPTX`
          );
        }

        return {
          name,
          content: content.trim(),
          size: Buffer.byteLength(content, "utf8"),
          type: this.getFileTypeCategory(name, type),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to extract content from "${name}": ${message}`);
      }
    });
  }

  /**
   * Extract text from multiple files
   */
  async extractFromFiles(files: any[], options: { ocr?: boolean } = {}): Promise<ExtractionResult> {
    if (!files.length) {
      throw new Error("No files provided for extraction");
    }

    // Validate all files before processing
    this.validateFiles(files);

    // Extract content from each file
    const extractedFiles = await Promise.all(
      files.map((file) => this.extractFromFile(file, options))
    );

    // Calculate total size and create combined content
    const totalSize = extractedFiles.reduce((sum, file) => sum + file.size, 0);

    if (totalSize > config.uploadMaxSizeBytes) {
      throw new Error(
        `Total extracted content size (${Math.round(
          totalSize / 1024
        )}KB) exceeds limit of ${Math.round(
          config.uploadMaxSizeBytes / 1024
        )}KB`
      );
    }

    const combinedContent = extractedFiles
      .map((file) => `===== FILE: ${file.name} =====\n${file.content}`)
      .join("\n\n");

    return {
      files: extractedFiles,
      totalSize,
      combinedContent: combinedContent.trim(),
    };
  }

  /**
   * Validate files before processing
   */
  private validateFiles(files: any[]): void {
    let totalRawSize = 0;

    for (const file of files) {
      const name = file.name || "unknown";
      const type = file.type || "";
      const size = file.size || 0;

      if (!isValidFileType(name, type)) {
        throw new Error(`Unsupported file type: "${name}"`);
      }

      totalRawSize += size;
      if (totalRawSize > config.uploadMaxSizeBytes) {
        throw new Error(
          `Total file size exceeds ${Math.round(
            config.uploadMaxSizeBytes / 1024 / 1024
          )}MB limit`
        );
      }
    }
  }

  /**
   * File type detection helpers
   */
  private isPdfFile(name: string, type: string): boolean {
    return type.includes("pdf") || name.toLowerCase().endsWith(".pdf");
  }

  isImageFile(name: string, type: string): boolean {
    return type.startsWith("image/") || /\.(png|jpe?g)$/i.test(name);
  }

  private isDocxFile(name: string, type: string): boolean {
    return (
      type.includes("wordprocessingml.document") ||
      name.toLowerCase().endsWith(".docx")
    );
  }

  private isPptxFile(name: string, type: string): boolean {
    return (
      type.includes("presentationml.presentation") ||
      name.toLowerCase().endsWith(".pptx")
    );
  }

  private isTextFile(name: string, type: string): boolean {
    return type.includes("text") || name.toLowerCase().endsWith(".txt");
  }

  private getFileTypeCategory(name: string, type: string): string {
    if (this.isPdfFile(name, type)) return "pdf";
    if (this.isImageFile(name, type)) return "image";
    if (this.isDocxFile(name, type)) return "docx";
    if (this.isPptxFile(name, type)) return "pptx";
    if (this.isTextFile(name, type)) return "text";
    return "unknown";
  }

  /**
   * Detect image type from buffer header
   */
  private detectImageType(buffer: Buffer): "png" | "jpeg" {
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
    if (
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    ) {
      return "jpeg";
    }

    // Default to jpeg
    return "jpeg";
  }
}

// Export singleton instance
export const extractionService = new ExtractionService();
