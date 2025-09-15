import { join } from "path";

/** Concurrency limiter to prevent PDF extraction memory spikes */
const PDF_EXTRACT_CONCURRENCY = Math.max(
  1,
  Number(process.env.PDF_EXTRACT_CONCURRENCY || 2)
);

function createPdfLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= concurrency) return;
    const job = queue.shift();
    if (!job) return;
    active++;
    job();
  };

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        fn()
          .then(resolve)
          .catch(reject)
          .finally(() => {
            active--;
            next();
          });
      };
      queue.push(run);
      next();
    });
  };
}

const pdfLimit = createPdfLimiter(PDF_EXTRACT_CONCURRENCY);

/** Wrapper export with concurrency guard */
export function extractPdfText(buffer: Buffer): Promise<string> {
  return pdfLimit(() => extractPdfTextImpl(buffer));
}

/**
 * Robust pdfjs loader for Node/Railway:
 * - Try legacy CJS build first (v3 style) to avoid DOMMatrix references.
 * - Fallback to ESM legacy build with a minimal DOMMatrix polyfill if needed.
 */
async function extractPdfTextImpl(buffer: Buffer): Promise<string> {
  let pdfjs: any;

  // Minimal DOMMatrix polyfill for Node in case pdfjs touches it
  if (!(globalThis as any).DOMMatrix) {
    (globalThis as any).DOMMatrix = class {
      // noop polyfill sufficient for text extraction paths
      constructor() {}
      multiplySelf() {
        return this;
      }
      translateSelf() {
        return this;
      }
      scaleSelf() {
        return this;
      }
      rotateSelf() {
        return this;
      }
      invertSelf() {
        return this;
      }
    };
  }

  try {
    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    pdfjs = require("pdfjs-dist/legacy/build/pdf.cjs");
  } catch {
    // Fallback to ESM legacy build (pdfjs v4+). Import module namespace.
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const m = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjs = m;
  }

  const data = new Uint8Array(buffer);

  // Configure standard fonts & CMaps (Node vs Serverless/Netlify)
  const isServerless =
    !!process.env.NETLIFY ||
    !!process.env.VERCEL ||
    !!process.env.AWS_LAMBDA_FUNCTION_NAME;

  const standardFontDataUrl = isServerless
    ? "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/standard_fonts/"
    : join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts") + "/";

  const cMapUrl = isServerless
    ? "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/cmaps/"
    : join(process.cwd(), "node_modules", "pdfjs-dist", "cmaps") + "/";

  let loadingTask: any | null = null;
  let pdf: any | null = null;

  try {
    loadingTask = pdfjs.getDocument({
      data,
      standardFontDataUrl,
      cMapUrl,
      cMapPacked: true,
    });
    pdf = await loadingTask.promise;

    let text = "";
    // Cap the number of pages processed to protect latency and memory
    const MAX_PAGES = Math.max(1, Number(process.env.PDF_MAX_PAGES || 200));
    const pageCount = Math.min(Number(pdf.numPages || 0), MAX_PAGES);

    for (let p = 1; p <= pageCount; p++) {
      const page = await pdf.getPage(p);
      try {
        const content = await page.getTextContent();
        const items: any[] = content.items || [];
        const strings = items.map((i: any) => i.str || "").filter(Boolean);
        text += strings.join(" ") + "\n\n";
      } finally {
        // Free page resources eagerly
        try {
          await (page as any)?.cleanup?.();
        } catch {}
      }
    }
    return text.trim();
  } finally {
    // Ensure document and task are torn down to avoid memory/file handle leaks
    try {
      await (pdf as any)?.cleanup?.();
    } catch {}
    try {
      await (pdf as any)?.destroy?.();
    } catch {}
    try {
      await (loadingTask as any)?.destroy?.();
    } catch {}
  }
}
