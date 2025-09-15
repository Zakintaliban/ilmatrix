import { Hono } from "hono";
import { promises as fs } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { extractPdfText } from "./extract/pdf.js";
import { extractImageText } from "./extract/image.js";
import { extractDocxText } from "./extract/docx.js";
import { extractPptxText } from "./extract/pptx.js";
import {
  generateAnswer,
  generateChat,
  generateQuizTrainerMCQ,
  scoreQuizTrainerMCQ,
  generateFlashcards,
  dialogueStart,
  dialogueStep,
  dialogueHint,
  dialogueFeedback,
} from "./groqClient.js";

type Task = "explain" | "quiz" | "forum" | "exam";

const defaultRoot = process.env.NETLIFY ? "/tmp" : process.cwd();
const uploadsDir = join(defaultRoot, "uploads");

async function ensureUploads() {
  await fs.mkdir(uploadsDir, { recursive: true });
}

async function readMaterial(
  materialId?: string,
  materialText?: string
): Promise<string> {
  if (materialText && materialText.trim()) return materialText;
  if (!materialId) throw new Error("materialId or materialText is required");
  return await fs.readFile(join(uploadsDir, `${materialId}.txt`), "utf8");
}

const api = new Hono();

api.post("/upload", async (c) => {
  try {
    await ensureUploads();
    const body = await c.req.parseBody();

    // Collect every file-like value from multipart body (support multiple "file" fields)
    const files: any[] = [];
    for (const [, v] of Object.entries(body as any)) {
      const pushIfFile = (x: any) => {
        if (x && typeof x.arrayBuffer === "function") files.push(x);
      };
      if (Array.isArray(v)) v.forEach(pushIfFile);
      else pushIfFile(v);
    }

    // Parse flags/ids for append/merge
    const scalar = (x: any) => (Array.isArray(x) ? x[0] : x);
    const appendRaw = scalar((body as any).append);
    const mergeToRaw =
      scalar((body as any).mergeTo) ?? scalar((body as any).materialId);
    const doAppend =
      typeof appendRaw === "string"
        ? /^(true|1|yes|on)$/i.test(appendRaw)
        : !!appendRaw;
    const targetId = doAppend ? String(mergeToRaw || "") : "";

    if (!files.length) {
      return c.json(
        {
          error:
            'Provide multipart/form-data with one or more "file" fields (PDF/TXT/PNG/JPG/DOCX/PPTX)',
        },
        400
      );
    }

    // Total upload size limit: 10 MB (applies to batch; when appending we also check aggregate)
    const LIMIT = 10 * 1024 * 1024;

    let batchBytes = 0;
    for (const f of files) {
      if (typeof (f as any).size === "number") batchBytes += (f as any).size;
      if (batchBytes > LIMIT) {
        return c.json({ error: "Total upload size exceeded 10 MB" }, 413);
      }
    }

    // Extract text from each file in the batch
    let combined = "";
    for (const f of files) {
      const name: string = (f as any).name ?? "file";
      const type: string = (f as any).type ?? "";

      let text = "";
      if (type.includes("pdf") || name.toLowerCase().endsWith(".pdf")) {
        const ab = await f.arrayBuffer();
        text = await extractPdfText(Buffer.from(ab));
      } else if (type.startsWith("image/") || /\.(png|jpe?g)$/i.test(name)) {
        const ab = await f.arrayBuffer();
        text = await extractImageText(Buffer.from(ab));
        if (!text.trim()) {
          return c.json(
            { error: `Unable to read text from image "${name}" (OCR empty)` },
            400
          );
        }
      } else if (
        type.includes(
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        ) ||
        name.toLowerCase().endsWith(".docx")
      ) {
        const ab = await f.arrayBuffer();
        text = await extractDocxText(Buffer.from(ab));
      } else if (
        type.includes(
          "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        ) ||
        name.toLowerCase().endsWith(".pptx")
      ) {
        const ab = await f.arrayBuffer();
        text = await extractPptxText(Buffer.from(ab));
      } else if (type.includes("text") || name.toLowerCase().endsWith(".txt")) {
        if (typeof (f as any).text === "function") {
          text = await (f as any).text();
        } else {
          const ab = await f.arrayBuffer();
          text = Buffer.from(ab).toString("utf8");
        }
      } else {
        return c.json(
          {
            error: `Unsupported type for "${name}". Use PDF, TXT, PNG/JPG, DOCX, or PPTX.`,
          },
          400
        );
      }

      combined += `\n===== FILE: ${name} =====\n${text}\n`;
    }

    combined = combined.trim();
    const sizeAdded = Buffer.byteLength(combined, "utf8");

    let materialId = "";
    let finalText = "";

    if (doAppend) {
      if (!targetId) {
        return c.json(
          {
            error:
              "append=true requires 'mergeTo' or 'materialId' to be provided",
          },
          400
        );
      }
      const path = join(uploadsDir, `${targetId}.txt`);
      let existing = "";
      try {
        existing = await fs.readFile(path, "utf8");
      } catch (e: any) {
        if (e?.code === "ENOENT") {
          return c.json(
            { error: `materialId '${targetId}' not found for append` },
            404
          );
        }
        throw e;
      }
      const existingBytes = Buffer.byteLength(existing, "utf8");
      if (existingBytes + sizeAdded > LIMIT) {
        return c.json(
          { error: "Total material size would exceed 10 MB", limit: "10MB" },
          413
        );
      }
      const stamp = new Date().toISOString();
      finalText = `${existing}\n\n===== APPEND BATCH ${stamp} =====\n${combined}`;
      await fs.writeFile(path, finalText, "utf8");
      materialId = targetId;
    } else {
      materialId = randomUUID();
      const path = join(uploadsDir, `${materialId}.txt`);
      finalText = combined;
      await fs.writeFile(path, finalText, "utf8");
    }

    const totalSize = Buffer.byteLength(finalText, "utf8");
    return c.json({
      materialId,
      appended: !!doAppend,
      files: files.length,
      size: totalSize,
      sizeAdded,
      limit: "10MB",
    });
  } catch (err: any) {
    console.error(err);
    return c.json({ error: "Upload failed", detail: err?.message }, 500);
  }
});

api.post("/explain", async (c) => {
  try {
    const { materialId, materialText, prompt } = await c.req.json();
    const text = await readMaterial(materialId, materialText);
    const answer = await generateAnswer({
      task: "explain",
      materialText: text,
      userInput: prompt,
    });
    return c.json({ answer });
  } catch (err: any) {
    console.error(err);
    return c.json({ error: "Explain failed", detail: err?.message }, 500);
  }
});

api.post("/quiz", async (c) => {
  try {
    const { materialId, materialText, prompt, numQuestions } =
      await c.req.json();
    const text = await readMaterial(materialId, materialText);
    const answer = await generateAnswer({
      task: "quiz",
      materialText: text,
      userInput: JSON.stringify({ prompt, numQuestions: numQuestions ?? 5 }),
    });
    return c.json({ answer });
  } catch (err: any) {
    console.error(err);
    return c.json({ error: "Quiz failed", detail: err?.message }, 500);
  }
});

api.post("/forum", async (c) => {
  try {
    const { materialId, materialText, prompt } = await c.req.json();
    const text = await readMaterial(materialId, materialText);
    const answer = await generateAnswer({
      task: "forum",
      materialText: text,
      userInput: prompt,
    });
    return c.json({ answer });
  } catch (err: any) {
    console.error(err);
    return c.json({ error: "Forum failed", detail: err?.message }, 500);
  }
});

api.post("/exam", async (c) => {
  try {
    const { materialId, materialText, prompt } = await c.req.json();
    const text = await readMaterial(materialId, materialText);
    const answer = await generateAnswer({
      task: "exam",
      materialText: text,
      userInput: prompt,
    });
    return c.json({ answer });
  } catch (err: any) {
    console.error(err);
    return c.json({ error: "Exam helper failed", detail: err?.message }, 500);
  }
});

// Chat endpoint: free-form chat with optional materials context
api.post("/chat", async (c) => {
  try {
    const { materialId, materialText, messages } = await c.req.json();
    const text =
      materialId || materialText
        ? await readMaterial(materialId, materialText)
        : "";
    const answer = await generateChat({
      materialText: text,
      messages: Array.isArray(messages) ? messages : [],
    });
    return c.json({ answer });
  } catch (err: any) {
    console.error(err);
    return c.json({ error: "Chat failed", detail: err?.message }, 500);
  }
});

// Quiz Trainer: generate questions (no answers)

// Quiz Trainer: submit answers for scoring + weakness analysis

// Peer feature removed

// MCQ Trainer: generate structured MCQs (A–E options, no answers)
api.post("/quiz/trainer/mcq/start", async (c) => {
  try {
    const { materialId, materialText, numQuestions } = await c.req.json();
    const text =
      materialId || materialText
        ? await readMaterial(materialId, materialText)
        : "";
    const result = await generateQuizTrainerMCQ({
      materialText: text,
      numQuestions: Number(numQuestions || 5),
    });
    return c.json(result);
  } catch (err: any) {
    console.error(err);
    return c.json(
      { error: "MCQ trainer start failed", detail: err?.message },
      500
    );
  }
});

// MCQ Trainer: score selected options and explain + study plan
api.post("/quiz/trainer/mcq/score", async (c) => {
  try {
    const { materialId, materialText, questions, userAnswers } =
      await c.req.json();
    const text =
      materialId || materialText
        ? await readMaterial(materialId, materialText)
        : "";
    const analysis = await scoreQuizTrainerMCQ({
      materialText: text,
      questions: Array.isArray(questions) ? questions : [],
      userAnswers: userAnswers || {},
    });
    return c.json({ analysis });
  } catch (err: any) {
    console.error(err);
    return c.json(
      { error: "MCQ trainer score failed", detail: err?.message },
      500
    );
  }
});

// Flashcards: generate N flashcards from materials
api.post("/flashcards", async (c) => {
  try {
    const { materialId, materialText, numCards } = await c.req.json();
    const text =
      materialId || materialText
        ? await readMaterial(materialId, materialText)
        : "";
    const result = await generateFlashcards({
      materialText: text,
      numCards: Number(numCards || 5),
    });
    return c.json(result);
  } catch (err: any) {
    console.error(err);
    return c.json(
      { error: "Flashcards generation failed", detail: err?.message },
      500
    );
  }
});
// ===== Dialogue endpoints =====
api.post("/dialogue/start", async (c) => {
  try {
    const { materialId, materialText } = await c.req.json();
    const text =
      materialId || materialText
        ? await readMaterial(materialId, materialText)
        : "";
    const result = await dialogueStart({ materialText: text });
    // frontend keeps session; we attach a pseudo id for convenience
    return c.json({ sessionId: randomUUID(), ...result });
  } catch (err: any) {
    console.error(err);
    return c.json(
      { error: "Dialogue start failed", detail: err?.message },
      500
    );
  }
});

api.post("/dialogue/step", async (c) => {
  try {
    const {
      materialId,
      materialText,
      topics,
      currentTopicIndex,
      userMessage,
      lastCoachQuestion,
      language,
    } = await c.req.json();

    const text =
      materialId || materialText
        ? await readMaterial(materialId, materialText)
        : "";

    // Special checkpoint: "How am I doing?"
    const isHowAmIDoing =
      typeof userMessage === "string" &&
      /^\s*how\s+am\s+i\s+doing\??\s*$/i.test(userMessage);

    if (isHowAmIDoing) {
      const total = Array.isArray(topics) ? topics.length : 3;
      const idx = Math.max(
        0,
        Math.min(Number(currentTopicIndex || 0), total - 1)
      );
      const title =
        (Array.isArray(topics) && topics[idx] && topics[idx].title) ||
        (language === "id" ? "topik saat ini" : "the current topic");
      const completed = Math.max(0, Math.min(idx, total));
      const msg =
        language === "id"
          ? `Kamu telah menyelesaikan ${completed} dari ${total} topik, dan saat ini kita membahas "${title}". Untuk melanjutkan: ${
              lastCoachQuestion || "silakan jawab pertanyaan terakhir."
            }`
          : `You've completed ${completed} of ${total} topics, and we are currently working on "${title}". To pick up where we left off: ${
              lastCoachQuestion || "please respond to the last question."
            }`;
      return c.json({
        addressed: false,
        moveToNext: false,
        coachMessage: msg,
      });
    }

    const currTitle =
      (Array.isArray(topics) &&
        topics?.[Number(currentTopicIndex || 0)]?.title) ||
      "";
    const nextTitle =
      (Array.isArray(topics) &&
        topics?.[Number(currentTopicIndex || 0) + 1]?.title) ||
      undefined;

    const result = await dialogueStep({
      materialText: text,
      language,
      currentTopicTitle: currTitle || (language === "id" ? "Topik" : "Topic"),
      userMessage: String(userMessage || ""),
      nextTopicTitle: nextTitle,
    });

    return c.json(result);
  } catch (err: any) {
    console.error(err);
    return c.json({ error: "Dialogue step failed", detail: err?.message }, 500);
  }
});

api.post("/dialogue/hint", async (c) => {
  try {
    const { materialId, materialText, currentTopicTitle, language } =
      await c.req.json();
    const text =
      materialId || materialText
        ? await readMaterial(materialId, materialText)
        : "";
    const result = await dialogueHint({
      materialText: text,
      language,
      currentTopicTitle: String(currentTopicTitle || ""),
    });
    return c.json(result);
  } catch (err: any) {
    console.error(err);
    return c.json({ error: "Dialogue hint failed", detail: err?.message }, 500);
  }
});

api.post("/dialogue/feedback", async (c) => {
  try {
    const { materialId, materialText, topics, history, language } =
      await c.req.json();
    const text =
      materialId || materialText
        ? await readMaterial(materialId, materialText)
        : "";
    const result = await dialogueFeedback({
      materialText: text,
      language,
      topics: Array.isArray(topics) ? topics : [],
      history: Array.isArray(history) ? history : [],
    });
    return c.json(result);
  } catch (err: any) {
    console.error(err);
    return c.json(
      { error: "Dialogue feedback failed", detail: err?.message },
      500
    );
  }
});

/** ===== Helpers to parse stored material into per-file segments ===== */
type FileSegment = {
  name: string;
  markerStart: number;
  contentStart: number;
  end: number;
};

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseFileSegments(text: string): FileSegment[] {
  const fileRe = /(^|\n)===== FILE: ([^\n]+) =====\n/g;
  const appendRe = /(^|\n)===== APPEND BATCH [^\n]* =====\n/g;

  // Collect boundary markers
  const fileMarkers: {
    name: string;
    markerStart: number;
    contentStart: number;
  }[] = [];
  const boundaries: number[] = [];

  let m: RegExpExecArray | null;
  while ((m = fileRe.exec(text))) {
    const prefixNL = m[1] ? 1 : 0;
    const markerStart = m.index + prefixNL;
    const name = m[2].trim();
    const headerLen = ("===== FILE: " + name + " =====\n").length;
    const contentStart = markerStart + headerLen;
    fileMarkers.push({ name, markerStart, contentStart });
    boundaries.push(markerStart);
  }
  while ((m = appendRe.exec(text))) {
    const prefixNL = m[1] ? 1 : 0;
    const markerStart = m.index + prefixNL;
    boundaries.push(markerStart);
  }
  boundaries.sort((a, b) => a - b);

  // Build segments by finding the next boundary after this marker
  const segments: FileSegment[] = [];
  for (let i = 0; i < fileMarkers.length; i++) {
    const fm = fileMarkers[i];
    // Find first boundary strictly greater than fm.markerStart
    let end = text.length;
    for (let j = 0; j < boundaries.length; j++) {
      const b = boundaries[j];
      if (b > fm.markerStart) {
        end = b;
        break;
      }
    }
    segments.push({
      name: fm.name,
      markerStart: fm.markerStart,
      contentStart: fm.contentStart,
      end,
    });
  }
  return segments;
}

/** ===== Material listing endpoint =====
 * Returns aggregated file names, their approximate character size, occurrences, and total size.
 */
api.get("/material/:id", async (c) => {
  try {
    await ensureUploads();
    const id = c.req.param("id");
    if (!id) return c.json({ error: "material id required" }, 400);
    const path = join(uploadsDir, `${id}.txt`);
    const text = await fs.readFile(path, "utf8").catch(() => "");
    if (!text) {
      return c.json({
        materialId: id,
        totalSize: 0,
        files: [],
      });
    }
    const segs = parseFileSegments(text);
    const byName: Record<
      string,
      { name: string; size: number; occurrences: number }
    > = {};
    for (const s of segs) {
      const size = Math.max(0, s.end - s.contentStart);
      if (!byName[s.name])
        byName[s.name] = { name: s.name, size: 0, occurrences: 0 };
      byName[s.name].size += size;
      byName[s.name].occurrences += 1;
    }
    const files = Object.values(byName).sort((a, b) => b.size - a.size);
    return c.json({
      materialId: id,
      totalSize: Buffer.byteLength(text, "utf8"),
      files,
    });
  } catch (err: any) {
    console.error(err);
    return c.json({ error: "List material failed", detail: err?.message }, 500);
  }
});

/** ===== Remove file(s) from a material by name (destructive) =====
 * Body: { name: string }
 * Removes all occurrences of that file name and rewrites the stored text.
 */
api.post("/material/:id/remove", async (c) => {
  try {
    await ensureUploads();
    const id = c.req.param("id");
    if (!id) return c.json({ error: "material id required" }, 400);
    const { name } = await c.req.json();
    if (!name || typeof name !== "string") {
      return c.json({ error: "name is required" }, 400);
    }

    const path = join(uploadsDir, `${id}.txt`);
    let text = await fs.readFile(path, "utf8").catch((e) => {
      if (e?.code === "ENOENT") return "";
      throw e;
    });
    if (!text) return c.json({ error: "material not found or empty" }, 404);

    const segs = parseFileSegments(text).filter((s) => s.name === name);
    if (!segs.length) {
      return c.json({ error: `file "${name}" not found in material` }, 404);
    }

    // Build new text by skipping segments to remove (including their headers)
    const removeRanges = parseFileSegments(text)
      .filter((s) => s.name === name)
      .sort((a, b) => a.markerStart - b.markerStart)
      .map((s) => ({ start: s.markerStart, end: s.end }));

    const parts: string[] = [];
    let cursor = 0;
    for (const r of removeRanges) {
      if (cursor < r.start) parts.push(text.slice(cursor, r.start));
      cursor = r.end;
    }
    if (cursor < text.length) parts.push(text.slice(cursor));
    let updated = parts.join("").trim();

    await fs.writeFile(path, updated, "utf8");

    // Return updated listing
    const segsAfter = parseFileSegments(updated);
    const byName: Record<
      string,
      { name: string; size: number; occurrences: number }
    > = {};
    for (const s of segsAfter) {
      const size = Math.max(0, s.end - s.contentStart);
      if (!byName[s.name])
        byName[s.name] = { name: s.name, size: 0, occurrences: 0 };
      byName[s.name].size += size;
      byName[s.name].occurrences += 1;
    }
    const files = Object.values(byName).sort((a, b) => b.size - a.size);

    return c.json({
      materialId: id,
      removed: name,
      totalSize: Buffer.byteLength(updated, "utf8"),
      files,
    });
  } catch (err: any) {
    console.error(err);
    return c.json({ error: "Remove failed", detail: err?.message }, 500);
  }
});

api.get("/health", (c) =>
  c.json({
    ok: true,
    uptime: Math.round(process.uptime()),
  })
);

/** ===== Material TTL auto-cleaner (auto delete old uploads) =====
 * Deletes uploads/<materialId>.txt files older than MATERIAL_TTL_MINUTES.
 * - Default TTL: 60 minutes
 * - Sweep interval: derived from TTL (bounded between 1–10 minutes)
 * - Silent/defensive: ignores errors so it never crashes the API
 */
const MATERIAL_TTL_MINUTES = Number(process.env.MATERIAL_TTL_MINUTES || "60");
const CLEAN_SWEEP_INTERVAL_MS = (() => {
  const ttlMs = Math.max(1, MATERIAL_TTL_MINUTES) * 60_000;
  // Aim ~6 sweeps per TTL; clamp between 1 min and 10 min
  const target = Math.floor(ttlMs / 6);
  return Math.max(60_000, Math.min(10 * 60_000, target || 10 * 60_000));
})();

let cleanerStarted = false;
// Keep handles so we can stop on shutdown and allow process to exit
let initialCleanerTimeout: ReturnType<typeof setTimeout> | null = null;
let cleanerInterval: ReturnType<typeof setInterval> | null = null;

async function cleanupOldMaterials() {
  try {
    await ensureUploads();
    const ttlMs =
      Math.max(
        1,
        Number(process.env.MATERIAL_TTL_MINUTES || MATERIAL_TTL_MINUTES) || 60
      ) * 60_000;
    const cutoff = Date.now() - ttlMs;

    // Read uploads directory (if missing, ensureUploads already created it)
    const names = await fs.readdir(uploadsDir).catch(() => []);
    for (const name of names) {
      if (!name.endsWith(".txt")) continue;
      const p = join(uploadsDir, name);
      try {
        const st = await fs.stat(p);
        const mtime =
          (st as any).mtimeMs ??
          (st.mtime instanceof Date ? st.mtime.getTime() : 0);
        if (Number(mtime) > 0 && mtime < cutoff) {
          await fs.unlink(p).catch(() => {});
        }
      } catch {
        // Ignore per-file errors to keep the sweep resilient
      }
    }
  } catch {
    // Ignore sweep-level errors
  }
}

function startMaterialCleaner() {
  if (cleanerStarted) return;
  cleanerStarted = true;
  // Initial delayed sweep (avoid blocking cold start)
  initialCleanerTimeout = setTimeout(() => {
    cleanupOldMaterials().catch(() => {});
  }, 30_000);
  // Don't keep the event loop alive
  (initialCleanerTimeout as any)?.unref?.();

  // Periodic sweep
  cleanerInterval = setInterval(() => {
    cleanupOldMaterials().catch(() => {});
  }, CLEAN_SWEEP_INTERVAL_MS);
  (cleanerInterval as any)?.unref?.();
}

export function stopMaterialCleaner() {
  try {
    if (initialCleanerTimeout) {
      clearTimeout(initialCleanerTimeout);
      initialCleanerTimeout = null;
    }
  } catch {}
  try {
    if (cleanerInterval) {
      clearInterval(cleanerInterval);
      cleanerInterval = null;
    }
  } catch {}
}

startMaterialCleaner();

export default api;
