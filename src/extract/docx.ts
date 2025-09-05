import JSZip from "jszip";

function xmlToText(xml: string): string {
  // Replace XML tags with spaces and decode a few entities
  const noTags = xml
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/&/g, "&")
    .replace(/<w:p[^>]*>/g, "\n") // paragraphs
    .replace(/<[^>]+>/g, " "); // any other tags
  // Collapse whitespace
  return noTags.replace(/\s+/g, " ").replace(/\n\s+/g, "\n").trim();
}

export async function extractDocxText(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  // Main document
  const main = zip.file("word/document.xml");
  if (!main) return "";
  const mainXml = await main.async("string");

  // Headers and footers if present
  const parts: string[] = [mainXml];
  const headerFiles = Object.keys(zip.files).filter((k) =>
    /^word\/header\d+\.xml$/.test(k)
  );
  const footerFiles = Object.keys(zip.files).filter((k) =>
    /^word\/footer\d+\.xml$/.test(k)
  );
  for (const f of [...headerFiles, ...footerFiles]) {
    try {
      const s = await zip.file(f)!.async("string");
      parts.push(s);
    } catch {}
  }

  const combined = parts.join("\n");
  return xmlToText(combined);
}
