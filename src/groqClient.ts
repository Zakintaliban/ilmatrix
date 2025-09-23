import "dotenv/config";
import Groq from "groq-sdk";

type Task = "explain" | "quiz" | "forum" | "exam";

/** ===== Safety: shared Groq client, concurrency limiter, and timeouts ===== */
const MODEL =
  process.env.GROQ_MODEL || "meta-llama/llama-4-maverick-17b-128e-instruct";

const GROQ_CONCURRENCY = Math.max(1, Number(process.env.GROQ_CONCURRENCY || 4));
const GROQ_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.GROQ_TIMEOUT_MS || 45000)
);

let _groqClient: Groq | null = null;
function getGroq(): Groq {
  const apiKey = process.env.GROQ_API_KEY;
  if (!_groqClient) {
    _groqClient = new Groq({ apiKey: apiKey || "" });
  }
  return _groqClient!;
}

// Minimal p-limit implementation (no external dep)
function createLimiter(concurrency: number) {
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

const groqLimit = createLimiter(GROQ_CONCURRENCY);

/** Timeout helper that races the operation against a timer (SDK does not support AbortSignal) */
async function withTimeout<T>(
  promiseFactory: () => Promise<T>,
  ms: number
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Request timeout"));
    }, ms);
    promiseFactory()
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

// Centralized chat completion wrapper with limiter + timeout
function callGroqChat(params: any) {
  return groqLimit(() =>
    withTimeout(
      () => getGroq().chat.completions.create({ ...params }),
      GROQ_TIMEOUT_MS
    )
  );
}

const systemPrompt = `You are Ilmatrix, a study assistant for university students, especially those who prefer studying quietly.
Core rules:
- Use the provided materials as the primary source. Quote short snippets (<= 120 characters) where relevant.
- Be concise, structured, and actionable.
- For quizzes/exams, guide learning first. Provide final answers only when explicitly requested and with brief justification; do NOT reveal chain-of-thought.
- Do not impersonate students or claim access to private systems. Encourage academic integrity.
- When uncertain, say so and suggest what information is missing.
- Output must be safe and respectful.`;

const MATERIAL_CLAMP = Math.max(
  4000,
  Number(process.env.MATERIAL_CLAMP || 100000)
);
function clamp(text: string, max = MATERIAL_CLAMP) {
  return text.length <= max ? text : text.slice(0, max);
}

export async function generateAnswer(params: {
  task: Task;
  materialText: string;
  userInput?: string;
}): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return "Server is missing GROQ_API_KEY. Set it in .env and restart.";
  }

  const { task, materialText, userInput } = params;

  const taskInstruction =
    task === "explain"
      ? "Explain the material clearly with a short summary, key points, and examples."
      : task === "quiz"
      ? "Assist with a quiz. If questions are provided, answer them with brief justifications and citations, and put the final answers in a separate section at the end titled 'Jawaban'. If questions are not provided, generate N plausible quiz questions first (numbered), then add a 'Jawaban' section at the end containing the answers. Do not reveal chain-of-thought; provide final answers with brief justification only."
      : task === "forum"
      ? "Draft a polite forum reply referencing this week’s material. Encourage discussion and add 1-2 thoughtful questions."
      : "Help prepare for an exam. Provide a study plan, likely topics, and how to approach tasks. If user requests, provide structured answers but remind them to use responsibly.";

  const userContent = `Task: ${task}
Extra Instruction: ${taskInstruction}

Materials:
---
${clamp(materialText)}
---

User Input:
${userInput ?? ""}`;

  const completion = await callGroqChat({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature: 0.3,
    max_tokens: 1200,
  });

  return completion.choices?.[0]?.message?.content ?? "";
}

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export async function generateChat(params: {
  materialText?: string;
  messages: ChatMessage[];
}): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return "Server is missing GROQ_API_KEY. Set it in .env and restart.";
  }

  const { materialText = "", messages } = params;

  // Compose message list: system prompt + optional context + conversation
  const chatMessages: {
    role: "system" | "user" | "assistant";
    content: string;
  }[] = [{ role: "system", content: systemPrompt }];

  if (materialText?.trim()) {
    chatMessages.push({
      role: "system",
      content:
        "Use the following course materials as context (quote short snippets <= 120 chars):\n---\n" +
        clamp(materialText) +
        "\n---",
    });
  }

  // Filter to allowed roles and ensure string content
  for (const m of messages) {
    if (!m?.content) continue;
    const role =
      m.role === "assistant"
        ? "assistant"
        : m.role === "system"
        ? "system"
        : "user";
    chatMessages.push({ role, content: String(m.content) });
  }

  const completion = await callGroqChat({
    model: MODEL,
    messages: chatMessages,
    temperature: 0.3,
    max_tokens: 1200,
  });

  return completion.choices?.[0]?.message?.content ?? "";
}

// === MCQ Trainer additions ===

export type MCQQuestion = {
  id: number;
  question: string;
  options: string[]; // exactly 5 options, text only (no leading A./B./C.)
  answer?: "A" | "B" | "C" | "D" | "E"; // correct answer letter (optional in older sets)
  rationale?: string; // brief explanation of the correct option
  weaknesses?: string[]; // 2–4 bullets describing likely misunderstandings for this question
  studyPlan?: string[]; // 2–4 bullets with actionable study steps for this question
};

export type MCQSet = {
  questions: MCQQuestion[];
};

function extractJsonBlock(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {}
  const m =
    text.match(/```json\s*([\s\S]*?)```/i) ||
    text.match(/```\s*([\s\S]*?)```/i);
  if (m && m[1]) {
    try {
      return JSON.parse(m[1]);
    } catch {}
  }
  // Try to find first {...} JSON object
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    const candidate = text.slice(braceStart, braceEnd + 1);
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return null;
}

/**
 * Generate MCQ set: questions with 5 options (A–E). No answers included.
 */
export async function generateQuizTrainerMCQ(params: {
  materialText: string;
  numQuestions: number;
}): Promise<MCQSet> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { questions: [] };

  const prompt = `From the materials ONLY, generate ${params.numQuestions} multiple-choice questions (MCQ) if the materials in Indonesia language, then give the result in Indonesia language, and if in english then give the result in english and always follow with what the language from the materials is.
Return ONLY JSON with this exact shape:

{
  "questions": [
    {
      "id": 1,
      "question": "…",
      "options": ["…","…","…","…","…"],
      "answer": "A",
      "rationale": "Brief 1–2 sentence explanation of why the answer is correct (materials-based, no chain-of-thought).",
      "weaknesses": ["bullet 1", "bullet 2"],
      "studyPlan": ["step 1", "step 2"]
    }
  ]
}

Rules:
- Use ONLY the provided materials; keep each question concise and unambiguous.
- Exactly 5 options per question (A–E). DO NOT prepend letters inside option texts; provide plain texts only.
- "answer" must be a single uppercase letter A|B|C|D|E.
- "rationale" should be brief (<= 2 sentences).
- Provide 2–4 bullets for "weaknesses" and 2–4 bullets for "studyPlan", specific to the concept of the question.
- Output valid JSON only (no markdown fences, no commentary).
`;

  const completion = await callGroqChat({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Materials:\n---\n${clamp(
          params.materialText
        )}\n---\n\n${prompt}`,
      },
    ],
    temperature: 0.2,
    max_tokens: 1200,
  });

  const raw = completion.choices?.[0]?.message?.content ?? "";
  const parsed = extractJsonBlock(raw) as MCQSet | null;

  const clean: MCQSet = { questions: [] };
  if (parsed?.questions && Array.isArray(parsed.questions)) {
    for (const q of parsed.questions) {
      const id = Number(q?.id);
      const question = String(q?.question || "").trim();
      const options = Array.isArray(q?.options)
        ? q.options.map((o: any) => String(o || "").trim())
        : [];
      const ansRaw = (q as any)?.answer
        ? String((q as any).answer)
            .trim()
            .toUpperCase()
        : undefined;
      const answer =
        ansRaw && ["A", "B", "C", "D", "E"].includes(ansRaw)
          ? (ansRaw as "A" | "B" | "C" | "D" | "E")
          : undefined;

      const rationale =
        typeof (q as any)?.rationale === "string"
          ? String((q as any).rationale).trim()
          : undefined;
      const weaknesses = Array.isArray((q as any)?.weaknesses)
        ? (q as any).weaknesses
            .map((w: any) => String(w || "").trim())
            .filter((s: string) => !!s)
        : undefined;
      const studyPlan = Array.isArray((q as any)?.studyPlan)
        ? (q as any).studyPlan
            .map((w: any) => String(w || "").trim())
            .filter((s: string) => !!s)
        : undefined;

      if (Number.isFinite(id) && question && options.length === 5) {
        clean.questions.push({
          id,
          question,
          options,
          answer,
          rationale,
          weaknesses,
          studyPlan,
        });
      }
    }
  }
  return clean;
}

/**
 * Score user's MCQ answers and provide explanations + study plan.
 * Adds a "Jawaban" section at the end listing the correct letters.
 */
export async function scoreQuizTrainerMCQ(params: {
  materialText: string;
  questions: MCQQuestion[];
  userAnswers: Record<number, "A" | "B" | "C" | "D" | "E">;
}): Promise<string> {
  // Deterministic checker (no LLM). Uses the embedded "answer" + per-question rationale/weaknesses/studyPlan.
  const qs = Array.isArray(params.questions) ? params.questions : [];
  const letters = ["A", "B", "C", "D", "E"] as const;

  // Build answer key by question id
  const keyById: Record<number, "A" | "B" | "C" | "D" | "E" | undefined> = {};
  for (const q of qs) {
    const ans = (q.answer || "").toString().toUpperCase();
    keyById[q.id] = (letters as readonly string[]).includes(ans)
      ? (ans as "A" | "B" | "C" | "D" | "E")
      : undefined;
  }

  const ua = (params.userAnswers || {}) as Record<number, string>;

  let totalWithKey = 0;
  let correct = 0;
  const lines: string[] = [];
  const finalKeyLines: string[] = [];

  qs.forEach((q, i) => {
    const idx = i + 1;
    const key = keyById[q.id];
    if (key) totalWithKey += 1;

    const user = (ua[q.id] || "").toString().toUpperCase() as
      | "A"
      | "B"
      | "C"
      | "D"
      | "E"
      | "";

    const isCorrect = !!key && user === key;
    if (isCorrect) correct += 1;

    // Base line
    lines.push(
      `${idx}) ${q.question}
Your: ${user || "-"} | Correct: ${key || "-"} ${isCorrect ? "✅" : "❌"}`
    );

    // Only when wrong: include per-question rationale/weaknesses/study plan if present
    if (!isCorrect) {
      if (q.rationale && q.rationale.trim()) {
        lines.push(`Explanation: ${q.rationale.trim()}`);
      }
      if (Array.isArray(q.weaknesses) && q.weaknesses.length) {
        lines.push("Weakness analysis:");
        for (const w of q.weaknesses) {
          const s = String(w || "").trim();
          if (s) lines.push(`- ${s}`);
        }
      }
      if (Array.isArray(q.studyPlan) && q.studyPlan.length) {
        lines.push("Study plan:");
        for (const s of q.studyPlan) {
          const t = String(s || "").trim();
          if (t) lines.push(`- ${t}`);
        }
      }
    }

    finalKeyLines.push(`${idx}) ${key || "-"}`);
  });

  const denominator = totalWithKey || qs.length || 0;
  const out: string[] = [
    `Score: ${correct}/${denominator}`,
    "",
    "Per-question:",
    ...lines,
  ];

  // Always end with the consolidated answer key
  out.push("", "Jawaban:");
  out.push(finalKeyLines.join("\n"));

  return out.join("\n");
}

// === Flashcards generator ===

export type Flashcard = {
  id: number;
  front: string; // question/prompt
  back: string; // concise answer
};

/**
 * Generate N flashcards from the provided materials.
 * Returns JSON: { cards: [{ id, front, back }, ...] }
 */
export async function generateFlashcards(params: {
  materialText: string;
  numCards: number;
}): Promise<{ cards: Flashcard[] }> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { cards: [] };

  const n = Math.max(1, Math.min(50, Number(params.numCards || 5)));

  const prompt = `From the materials ONLY, generate ${n} flashcards as JSON. if the materials in Indonesia language, then give the result in Indonesia language, and if in english then give the result in english and always follow with what the language from the materials is.

Return ONLY valid JSON with this exact shape (no markdown fences, no commentary):
{
  "cards": [
    { "id": 1, "front": "Question or prompt ...", "back": "Concise answer grounded in the materials." }
  ]
}

Rules:
- Use only information from the materials; if unsure, skip that concept.
- Make each flashcard focused, clear, and concise; avoid duplicates.
- Keep "back" short and factual (no chain-of-thought).
- Output exactly ${n} items in the "cards" array.
`;

  const completion = await callGroqChat({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Materials:\n---\n${clamp(
          params.materialText
        )}\n---\n\n${prompt}`,
      },
    ],
    temperature: 0.2,
    max_tokens: 1200,
  });

  const raw = completion.choices?.[0]?.message?.content ?? "";
  const parsed = extractJsonBlock(raw) as { cards?: any[] } | null;

  const clean: Flashcard[] = [];
  if (parsed?.cards && Array.isArray(parsed.cards)) {
    for (const c of parsed.cards) {
      const id = Number(c?.id);
      const front = String(c?.front || c?.q || "").trim();
      const back = String(c?.back || c?.a || "").trim();
      if (Number.isFinite(id) && front && back) {
        clean.push({ id, front, back });
      }
    }
  }

  // If the model failed to produce enough, trim or pad (no hallucination padding)
  // We just return whatever valid cards we parsed.
  return { cards: clean.slice(0, n) };
}

// === Dialogue (coached conversation) ===

export type DialogueTopic = { id: number; title: string };
export type DialogueStartResult = {
  language: string; // e.g., "id" or "en"
  intro: string; // opener text to show after Start
  topics: DialogueTopic[]; // exactly 3 topics
  firstCoachPrompt: string; // first coach question to begin topic 1
};

export type DialogueStepResult = {
  addressed: boolean; // did user's answer sufficiently address current topic?
  moveToNext: boolean; // if true and there is a next topic, UI should advance
  coachMessage: string; // coach reply to show
  nextCoachQuestion?: string; // if moving to next topic, the first question for that topic
};

export type DialogueHintResult = { hint: string };

export type DialogueFeedbackResult = {
  feedback: string; // final feedback paragraph(s)
  strengths: string[];
  improvements: string[];
};

function detectLangFromText(text: string): "id" | "en" | "auto" {
  // very light heuristic; final decision is by model
  const sample = (text || "").slice(0, 400).toLowerCase();
  const hasIndo =
    /\b(yang|dan|atau|dengan|adalah|tidak|untuk|dari|pada|dalam|itu|ini)\b/.test(
      sample
    );
  return hasIndo ? "id" : "auto";
}

/**
 * Start a Dialogue session by proposing 3 topics and an intro + first coach prompt.
 * The model returns JSON only to keep parsing robust.
 */
export async function dialogueStart(params: {
  materialText: string;
}): Promise<DialogueStartResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return {
      language: "en",
      intro:
        "Welcome! Dialogue could not start because GROQ_API_KEY is missing on the server.",
      topics: [
        { id: 1, title: "Topic 1" },
        { id: 2, title: "Topic 2" },
        { id: 3, title: "Topic 3" },
      ],
      firstCoachPrompt:
        "Please configure your GROQ API key and restart the server.",
    };
  }

  const langHint = detectLangFromText(params.materialText);

  const prompt = `
You are a coach facilitating a short, structured Dialogue grounded ONLY in the provided course materials. Detect the language (Indonesian vs English). Output JSON only.

Return this exact JSON structure:

{
  "language": "id|en",
  "intro": "ilmatrix opener text (short). Include: a welcome line referencing the material's theme; a bullet list of 3 topics to cover (using the topic titles you define below); a single sentence telling the user to click \\"I'm stuck\\" for a hint; and a closing line instructing to click \\"Let's get started!\\".",
  "topics": [
    { "id": 1, "title": "short topic 1 title" },
    { "id": 2, "title": "short topic 2 title" },
    { "id": 3, "title": "short topic 3 title" }
  ],
  "firstCoachPrompt": "Coach's first question to begin topic 1 (one sentence, specific, grounded in the materials)."
}

Rules:
- Language: if materials appear Indonesian, return Indonesian; otherwise English.
- Topics: concise, unambiguous, and tailored to the materials. Exactly 3.
- Keep intro tight (<= 120 words). Use a friendly coaching tone. No chain-of-thought.
- Do NOT wrap JSON in markdown fences. No commentary. JSON only.
`;

  const completion = await callGroqChat({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content:
          `Materials:\n---\n${clamp(params.materialText)}\n---\n\n` +
          `Lang hint: ${langHint}\n` +
          prompt,
      },
    ],
    temperature: 0.3,
    max_tokens: 800,
  });

  const raw = completion.choices?.[0]?.message?.content ?? "{}";
  const parsed = (extractJsonBlock(raw) || {}) as DialogueStartResult;

  // Decide language using model output or heuristic hint
  const lang: "id" | "en" =
    parsed.language === "id" || parsed.language === "en"
      ? parsed.language
      : langHint === "id"
      ? "id"
      : "en";

  // Topics: prefer model output; otherwise use neutral, materials-agnostic defaults
  const defaultTopics: DialogueTopic[] =
    lang === "id"
      ? [
          { id: 1, title: "Konsep inti" },
          { id: 2, title: "Contoh/penerapan" },
          { id: 3, title: "Miskonsepsi umum & klarifikasi" },
        ]
      : [
          { id: 1, title: "Core concepts" },
          { id: 2, title: "Examples/applications" },
          { id: 3, title: "Common misconceptions & clarification" },
        ];

  const topics: DialogueTopic[] =
    Array.isArray(parsed.topics) && parsed.topics.length === 3
      ? parsed.topics.map((t, i) => ({
          id: Number(t?.id ?? i + 1),
          title: String(t?.title || `Topic ${i + 1}`),
        }))
      : defaultTopics;

  const t1 =
    topics[0]?.title || (lang === "id" ? "Konsep inti" : "Core concepts");

  return {
    language: lang,
    intro:
      parsed.intro ||
      (lang === "id"
        ? "Selamat datang! Klik 'Start' untuk memulai Dialogue."
        : "Welcome! Click 'Start' to begin the Dialogue."),
    topics,
    firstCoachPrompt:
      parsed.firstCoachPrompt ||
      (lang === "id"
        ? `Mulai dari topik 1 (${t1}). Apa ide utama dari materi? Kutip potongan pendek (<=120 karakter) yang mendukung.`
        : `Start with topic 1 (${t1}). What is the main idea from the material? Quote a short snippet (<=120 chars) that supports it.`),
  };
}

/**
 * Judge user's answer for the current topic and produce a coach reply.
 * If addressed, also provide a starter question for the next topic (if provided).
 * Returns JSON only for robust parsing.
 */
export async function dialogueStep(params: {
  materialText: string;
  language?: string; // "id"|"en"
  currentTopicTitle: string;
  userMessage: string;
  nextTopicTitle?: string; // optional; if present and addressed=true, produce nextCoachQuestion
}): Promise<DialogueStepResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return {
      addressed: false,
      moveToNext: false,
      coachMessage:
        "Dialogue cannot proceed because GROQ_API_KEY is missing on the server.",
    };
  }

  const prompt = `
You are a concise coach. Evaluate whether the user's message sufficiently addresses the CURRENT TOPIC. Use ONLY the provided materials for grounding. Output JSON only.

JSON format:
{
  "addressed": true|false,
  "moveToNext": true|false,
  "coachMessage": "one or two short paragraphs in the detected language (no chain-of-thought)",
  "nextCoachQuestion": "if moveToNext=true and NEXT TOPIC is provided, ask a clear first question for that next topic; else omit"
}

Constraints:
- If the user's answer sufficiently addresses CURRENT TOPIC, set addressed=true and moveToNext=true.
  - Provide a brief positive acknowledgement and transition.
  - If NEXT TOPIC is provided, include a strong first question for NEXT TOPIC in "nextCoachQuestion".
- If not sufficient, set addressed=false and moveToNext=false.
  - Provide a short, targeted follow-up question within CURRENT TOPIC to help the user improve the answer.
- Keep it tight and helpful, grounded in the materials. No JSON markdown fences, JSON only.
`;

  const userBlock = `
LANGUAGE: ${params.language || "auto"}
CURRENT TOPIC: ${params.currentTopicTitle}
NEXT TOPIC: ${params.nextTopicTitle || "(none)"}

MATERIALS:
---
${clamp(params.materialText)}
---

USER MESSAGE:
${params.userMessage}
`;

  const completion = await callGroqChat({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt + "\n" + userBlock },
    ],
    temperature: 0.3,
    max_tokens: 700,
  });

  const raw = completion.choices?.[0]?.message?.content ?? "{}";
  const parsed = (extractJsonBlock(raw) || {}) as Partial<DialogueStepResult>;
  return {
    addressed: !!parsed.addressed,
    moveToNext: !!parsed.moveToNext,
    coachMessage: String(parsed.coachMessage || "").trim(),
    nextCoachQuestion: parsed.nextCoachQuestion
      ? String(parsed.nextCoachQuestion || "").trim()
      : undefined,
  };
}

/**
 * Provide a short, actionable hint for the current topic.
 */
export async function dialogueHint(params: {
  materialText: string;
  language?: string;
  currentTopicTitle: string;
}): Promise<DialogueHintResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { hint: "Server missing GROQ_API_KEY." };

  const prompt = `
Give ONE short hint (1–2 sentences) to help the learner progress on the CURRENT TOPIC. Use the materials only. Output JSON only: { "hint": "..." } in the detected language. No fences, no commentary.`;

  const content = `
LANGUAGE: ${params.language || "auto"}
CURRENT TOPIC: ${params.currentTopicTitle}

MATERIALS:
---
${clamp(params.materialText)}
---
`;

  const completion = await callGroqChat({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt + "\n" + content },
    ],
    temperature: 0.2,
    max_tokens: 200,
  });

  const raw = completion.choices?.[0]?.message?.content ?? "{}";
  const parsed = (extractJsonBlock(raw) || {}) as DialogueHintResult;
  return { hint: String(parsed.hint || "").trim() };
}

/**
 * Produce final feedback: a short summary paragraph + strengths and improvements.
 */
export async function dialogueFeedback(params: {
  materialText: string;
  language?: string;
  topics: { title: string }[];
  history: {
    role: "coach" | "user" | "ilmatrix" | "system";
    content: string;
  }[];
}): Promise<DialogueFeedbackResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return {
      feedback:
        "Feedback unavailable because the server is missing GROQ_API_KEY.",
      strengths: [],
      improvements: [],
    };
  }

  const prompt = `
Based on the short Dialogue history and the topics, provide final feedback in the detected language. Output JSON only:

{
  "feedback": "short closing paragraph summarizing the session focus and learner's performance",
  "strengths": ["...", "..."],
  "improvements": ["...", "..."]
}

Rules:
- Use only the conversation and materials for grounding.
- Keep strengths and improvements concrete (2–4 items each).
- No markdown fences, no extra commentary.
`;

  const convoText = (params.history || [])
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");

  const content = `
LANGUAGE: ${params.language || "auto"}
TOPICS: ${(params.topics || []).map((t) => t.title).join(" | ")}

MATERIALS:
---
${clamp(params.materialText)}
---

DIALOGUE HISTORY (trimmed):
---
${clamp(convoText, 8000)}
---
`;

  const completion = await callGroqChat({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt + "\n" + content },
    ],
    temperature: 0.2,
    max_tokens: 800,
  });

  const raw = completion.choices?.[0]?.message?.content ?? "{}";
  const parsed = (extractJsonBlock(raw) ||
    {}) as Partial<DialogueFeedbackResult>;
  return {
    feedback: String(parsed.feedback || "").trim(),
    strengths: Array.isArray(parsed.strengths)
      ? parsed.strengths.map((s) => String(s || "").trim()).filter(Boolean)
      : [],
    improvements: Array.isArray(parsed.improvements)
      ? parsed.improvements.map((s) => String(s || "").trim()).filter(Boolean)
      : [],
  };
}
