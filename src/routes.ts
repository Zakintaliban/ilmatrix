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
  generateQuizTrainerQuestions,
  scoreQuizTrainer,
  generateQuizTrainerMCQ,
  scoreQuizTrainerMCQ,
  generateFlashcards,
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
    const file: any = (body as any)["file"];
    if (!file || typeof file.arrayBuffer !== "function") {
      return c.json(
        {
          error:
            'Provide multipart/form-data with field "file" (PDF/TXT/PNG/JPG/DOCX/PPTX)',
        },
        400
      );
    }

    const name: string = (file as any).name ?? "file";
    const type: string = (file as any).type ?? "";
    const id = randomUUID();

    let text = "";
    if (type.includes("pdf") || name.toLowerCase().endsWith(".pdf")) {
      const ab = await file.arrayBuffer();
      text = await extractPdfText(Buffer.from(ab));
    } else if (type.startsWith("image/") || /\.(png|jpe?g)$/i.test(name)) {
      const ab = await file.arrayBuffer();
      text = await extractImageText(Buffer.from(ab));
      if (!text.trim()) {
        return c.json(
          { error: "Unable to read text from image (OCR empty)" },
          400
        );
      }
    } else if (
      // DOCX MIME + extension
      type.includes(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ) ||
      name.toLowerCase().endsWith(".docx")
    ) {
      const ab = await file.arrayBuffer();
      text = await extractDocxText(Buffer.from(ab));
    } else if (
      // PPTX MIME + extension
      type.includes(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      ) ||
      name.toLowerCase().endsWith(".pptx")
    ) {
      const ab = await file.arrayBuffer();
      text = await extractPptxText(Buffer.from(ab));
    } else if (type.includes("text") || name.toLowerCase().endsWith(".txt")) {
      // Some runtimes support file.text()
      if (typeof file.text === "function") {
        text = await file.text();
      } else {
        const ab = await file.arrayBuffer();
        text = Buffer.from(ab).toString("utf8");
      }
    } else {
      return c.json(
        { error: "Unsupported type. Use PDF, TXT, PNG/JPG, DOCX, or PPTX." },
        400
      );
    }

    await fs.writeFile(join(uploadsDir, `${id}.txt`), text, "utf8");
    return c.json({ materialId: id, size: text.length });
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
api.post("/quiz/trainer/start", async (c) => {
  try {
    const { materialId, materialText, numQuestions } = await c.req.json();
    const text =
      materialId || materialText
        ? await readMaterial(materialId, materialText)
        : "";
    const result = await generateQuizTrainerQuestions({
      materialText: text,
      numQuestions: Number(numQuestions || 5),
    });
    return c.json(result);
  } catch (err: any) {
    console.error(err);
    return c.json({ error: "Trainer start failed", detail: err?.message }, 500);
  }
});

// Quiz Trainer: submit answers for scoring + weakness analysis
api.post("/quiz/trainer/score", async (c) => {
  try {
    const {
      materialId,
      materialText,
      questions,
      answers,
      questionsText,
      answersText,
    } = await c.req.json();
    const text =
      materialId || materialText
        ? await readMaterial(materialId, materialText)
        : "";
    const analysis = await scoreQuizTrainer({
      materialText: text,
      questions: Array.isArray(questions) ? questions : [],
      answers: Array.isArray(answers) ? answers : [],
      questionsText,
      answersText,
    });
    return c.json({ analysis });
  } catch (err: any) {
    console.error(err);
    return c.json({ error: "Trainer score failed", detail: err?.message }, 500);
  }
});

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

export default api;
