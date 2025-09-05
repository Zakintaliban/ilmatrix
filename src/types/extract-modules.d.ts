declare module "./extract/docx.js" {
  export function extractDocxText(buffer: Buffer): Promise<string>;
}
declare module "./extract/pptx.js" {
  export function extractPptxText(buffer: Buffer): Promise<string>;
}
