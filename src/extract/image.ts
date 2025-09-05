import Tesseract from "tesseract.js";

export async function extractImageText(buffer: Buffer): Promise<string> {
  // Try Indonesian + English; fallback to English if language data unavailable
  const langs = ["eng+ind", "eng"];
  for (const lang of langs) {
    try {
      const { data } = await Tesseract.recognize(buffer, lang, {
        // silence logs in server
        logger: () => {},
      });
      const text = (data.text || "").trim();
      if (text) return text;
    } catch {
      // try next lang
    }
  }
  return "";
}
