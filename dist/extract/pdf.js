import { join } from "path";
/**
 * Robust pdfjs loader for Node/Railway:
 * - Try legacy CJS build first (v3 style) to avoid DOMMatrix references.
 * - Fallback to ESM legacy build with a minimal DOMMatrix polyfill if needed.
 */
export async function extractPdfText(buffer) {
    let pdfjs;
    // Minimal DOMMatrix polyfill for Node in case pdfjs touches it
    if (!globalThis.DOMMatrix) {
        globalThis.DOMMatrix = class {
            // noop polyfill sufficient for text extraction paths
            constructor() { }
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
    }
    catch {
        // Fallback to ESM legacy build (pdfjs v4+). Import module namespace.
        // eslint-disable-next-line @typescript-eslint/consistent-type-imports
        const m = await import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfjs = m;
    }
    const data = new Uint8Array(buffer);
    // Configure standard fonts & CMaps (Node vs Serverless/Netlify)
    const isServerless = !!process.env.NETLIFY ||
        !!process.env.VERCEL ||
        !!process.env.AWS_LAMBDA_FUNCTION_NAME;
    const standardFontDataUrl = isServerless
        ? "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/standard_fonts/"
        : join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts") + "/";
    const cMapUrl = isServerless
        ? "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/cmaps/"
        : join(process.cwd(), "node_modules", "pdfjs-dist", "cmaps") + "/";
    const loadingTask = pdfjs.getDocument({
        data,
        standardFontDataUrl,
        cMapUrl,
        cMapPacked: true,
    });
    const pdf = await loadingTask.promise;
    let text = "";
    for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        const items = content.items || [];
        const strings = items.map((i) => i.str || "").filter(Boolean);
        text += strings.join(" ") + "\n\n";
    }
    return text.trim();
}
