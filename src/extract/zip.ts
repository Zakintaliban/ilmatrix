import JSZip from "jszip";

/**
 * Bounded reading of Office (DOCX/PPTX) zip archives.
 *
 * A 10 MB upload can hold gigabytes of compressed zeros (a "zip bomb"); reading
 * its parts with `async("string")` would exhaust memory. The reader counts the
 * bytes actually decompressed (the sizes declared inside a zip can lie) and
 * stops once one document's parts exceed the budget.
 */

/** Uncompressed XML read per document. Real decks and documents use a few MB. */
export const MAX_OFFICE_XML_BYTES = 50 * 1024 * 1024;
/** Parts read per document (slides, headers, footers). */
export const MAX_OFFICE_PARTS = 1000;

export class OfficeFileTooLargeError extends Error {
  constructor() {
    super(
      `Document content is too large to process (over ${MAX_OFFICE_XML_BYTES / 1024 / 1024} MB uncompressed). ` +
        "The file may be damaged; try exporting it again or uploading it as PDF."
    );
    this.name = "OfficeFileTooLargeError";
  }
}

export class BoundedZipReader {
  private used = 0;
  private parts = 0;

  private constructor(private readonly zip: JSZip, private readonly limit: number) {}

  static async open(buffer: Buffer, limit = MAX_OFFICE_XML_BYTES): Promise<BoundedZipReader> {
    return new BoundedZipReader(await JSZip.loadAsync(buffer), limit);
  }

  /** Entry names (directory metadata only, nothing is decompressed). */
  names(): string[] {
    return Object.keys(this.zip.files);
  }

  /** Read one part as UTF-8, or null if it doesn't exist. Throws OfficeFileTooLargeError over budget. */
  async readText(name: string): Promise<string | null> {
    const file = this.zip.file(name);
    if (!file || file.dir) return null;
    if (++this.parts > MAX_OFFICE_PARTS) throw new OfficeFileTooLargeError();

    const chunks: Buffer[] = [];
    // JSZip's stream comes from the old readable-stream package (not async iterable)
    const stream = file.nodeStream("nodebuffer") as NodeJS.ReadableStream & { destroy?: () => void };
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => {
        this.used += chunk.length;
        if (this.used > this.limit) {
          // Stop inflating: no further reads are requested from JSZip
          stream.pause();
          stream.removeAllListeners("data");
          stream.destroy?.();
          reject(new OfficeFileTooLargeError());
          return;
        }
        chunks.push(chunk);
      });
      stream.on("end", () => resolve());
      stream.on("error", (error: Error) => reject(error));
    });
    return Buffer.concat(chunks).toString("utf8");
  }
}

/** Decode the XML entities Office writes in text (after tags are removed). */
export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => safeCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function safeCodePoint(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}
