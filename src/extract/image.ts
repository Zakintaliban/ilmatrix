import { createWorker } from "tesseract.js";

export async function extractImageText(buffer: Buffer): Promise<string> {
  // Try Indonesian + English; fallback to English if language data unavailable
  const langs = ["eng+ind", "eng"];
  const OCR_TIMEOUT_MS = Math.max(
    1000,
    Number(process.env.OCR_TIMEOUT_MS || 30000)
  );

  for (const lang of langs) {
    let worker: any = null;
    let timeoutId: any = null;
    try {
      // Create worker without config to satisfy type signatures across versions
      worker = await (createWorker as any)();

      // Load language and initialize
      await worker.loadLanguage(lang);
      await worker.initialize(lang);

      // Recognize with timeout protection
      const result: any = await Promise.race([
        worker.recognize(buffer),
        new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("OCR timeout")),
            OCR_TIMEOUT_MS
          );
        }),
      ]);

      const text = String(result?.data?.text || "").trim();
      if (text) return text;
    } catch {
      // try next language
    } finally {
      try {
        if (timeoutId) clearTimeout(timeoutId);
      } catch {}
      try {
        await worker?.terminate?.();
      } catch {}
    }
  }
  return "";
}
