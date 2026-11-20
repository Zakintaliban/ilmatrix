import { BoundedZipReader, OfficeFileTooLargeError, decodeXmlEntities } from "./zip.js";

function xmlToText(xml: string): string {
  const noTags = xml
    .replace(/<w:p[^>]*>/g, "\n") // paragraphs
    .replace(/<[^>]+>/g, " "); // any other tags
  // Collapse whitespace, then decode entities (after tags are gone, so &lt; stays text)
  return decodeXmlEntities(noTags.replace(/\s+/g, " ").replace(/\n\s+/g, "\n").trim());
}

export async function extractDocxText(buffer: Buffer): Promise<string> {
  const zip = await BoundedZipReader.open(buffer);
  // Main document
  const mainXml = await zip.readText("word/document.xml");
  if (mainXml === null) return "";

  // Headers and footers if present
  const parts: string[] = [mainXml];
  const headerFooterFiles = zip.names().filter((k) => /^word\/(header|footer)\d+\.xml$/.test(k));
  for (const f of headerFooterFiles) {
    try {
      const s = await zip.readText(f);
      if (s) parts.push(s);
    } catch (error) {
      if (error instanceof OfficeFileTooLargeError) throw error;
      // ignore a broken header/footer
    }
  }

  const combined = parts.join("\n");
  return xmlToText(combined);
}
