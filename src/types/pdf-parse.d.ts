declare module "pdf-parse" {
  interface PDFParseResult {
    numpages: number;
    numrender: number;
    info: Record<string, any>;
    metadata: any;
    version: string;
    text: string;
  }

  function pdf(buffer: Buffer | Uint8Array): Promise<PDFParseResult>;
  export default pdf;
}
