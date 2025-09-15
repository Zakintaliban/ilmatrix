import { createWorker } from "tesseract.js";

/** Concurrency limiter for OCR to avoid spawning too many workers */
const OCR_CONCURRENCY = Math.max(1, Number(process.env.OCR_CONCURRENCY || 1));
function createOcrLimiter(concurrency: number) {
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
const ocrLimit = createOcrLimiter(OCR_CONCURRENCY);

export function extractImageText(buffer: Buffer): Promise<string> {
  return ocrLimit(() => extractImageTextImpl(buffer));
}

async function extractImageTextImpl(buffer: Buffer): Promise<string> {
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
