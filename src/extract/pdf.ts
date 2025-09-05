import { join } from "path";

/**
 * pdfjs-dist DOMMatrix fix for Node/Railway:
 * Use the legacy CJS build to avoid browser display-layer paths that reference DOMMatrix.
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const { createRequire } = await import("module");
  const require = createRequire(import.meta.url);
  // Force Node-friendly build
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdfjs: any = require("pdfjs-dist/legacy/build/pdf.cjs");

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
    const items: any[] = content.items || [];
    const strings = items.map((i: any) => i.str || "").filter(Boolean);
    text += strings.join(" ") + "\n\n";
  }
  return text.trim();
}
