import { BoundedZipReader, OfficeFileTooLargeError, decodeXmlEntities } from "./zip.js";

function xmlToPlain(xml: string): string {
  // Extract text nodes inside a:t tags (PowerPoint text runs)
  const matches = Array.from(xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)).map(
    (m) => m[1]
  );
  const joined = matches.join(" ");
  // Whitespace normalize, then decode entities
  return decodeXmlEntities(joined.replace(/\s+/g, " ").trim());
}

export async function extractPptxText(buffer: Buffer): Promise<string> {
  const zip = await BoundedZipReader.open(buffer);

  // Collect slide files
  const slideFiles = zip
    .names()
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml/)?.[1] || 0);
      const nb = Number(b.match(/slide(\d+)\.xml/)?.[1] || 0);
      return na - nb;
    });

  const slides: string[] = [];
  for (const f of slideFiles) {
    try {
      const xml = await zip.readText(f);
      const text = xml ? xmlToPlain(xml) : "";
      if (text) slides.push(text);
    } catch (error) {
      if (error instanceof OfficeFileTooLargeError) throw error;
      // ignore broken slide
    }
  }

  return slides.join("\n\n").trim();
}
