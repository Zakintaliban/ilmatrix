import "dotenv/config";
import Groq from "groq-sdk";

type Task = "explain" | "quiz" | "forum" | "exam";

const MODEL =
  process.env.GROQ_MODEL || "meta-llama/llama-4-maverick-17b-128e-instruct";

const systemPrompt = `You are StudyAI, a study assistant for university students, especially those who prefer studying quietly.
Core rules:
- Use the provided materials as the primary source. Quote short snippets (<= 120 characters) where relevant.
- Be concise, structured, and actionable.
- For quizzes/exams, guide learning first. Provide final answers only when explicitly requested and with brief justification; do NOT reveal chain-of-thought.
- Do not impersonate students or claim access to private systems. Encourage academic integrity.
- When uncertain, say so and suggest what information is missing.
- Output must be safe and respectful.`;

function clamp(text: string, max = 12000) {
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
  const groq = new Groq({ apiKey });

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

  const completion = await groq.chat.completions.create({
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
  const groq = new Groq({ apiKey });

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

  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages: chatMessages,
    temperature: 0.3,
    max_tokens: 1200,
  });

  return completion.choices?.[0]?.message?.content ?? "";
}

/**
 * Generate quiz trainer questions from materials.
 * Return as a numbered list (no answers), concise and well-formed.
 */
export async function generateQuizTrainerQuestions(params: {
  materialText: string;
  numQuestions: number;
}): Promise<{ questions: string }> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { questions: "Server is missing GROQ_API_KEY." };
  const groq = new Groq({ apiKey });

  const prompt = `Generate ${params.numQuestions} quiz questions FROM the materials only. Do NOT include answers in this section.
Format strictly as:
1) <question one>
2) <question two>
...
Keep each question concise but unambiguous.`;

  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content:
          `Materials:\n---\n${clamp(params.materialText)}\n---\n\n` + prompt,
      },
    ],
    temperature: 0.2,
    max_tokens: 800,
  });

  const questions = completion.choices?.[0]?.message?.content ?? "";
  return { questions };
}

/**
 * Score user's answers and provide weakness analysis.
 * Accept either arrays (questions/answers) OR raw text blocks (questionsText/answersText).
 */
export async function scoreQuizTrainer(params: {
  materialText: string;
  questions?: string[];
  answers?: string[];
  questionsText?: string;
  answersText?: string;
}): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return "Server is missing GROQ_API_KEY.";
  const groq = new Groq({ apiKey });

  const qBlock =
    (params.questions && params.questions.length
      ? params.questions.map((q, i) => `${i + 1}) ${q}`).join("\n")
      : params.questionsText || "") || "";
  const aBlock =
    (params.answers && params.answers.length
      ? params.answers.map((a, i) => `${i + 1}) ${a}`).join("\n")
      : params.answersText || "") || "";

  const prompt = `You are a strict quiz trainer. Using ONLY the materials (cite short snippets <=120 chars), grade and analyze the user's answers.
Provide:
- Score: X/Y
- Per-question brief feedback
- Weakness analysis (3-5 bullet points), and a short study plan.
Do NOT reveal chain-of-thought, only final justifications and short citations.`;

  const content = `Materials:\n---\n${clamp(params.materialText)}\n---\n
Questions (numbered):
${qBlock}

User Answers (numbered):
${aBlock}`;

  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `${prompt}\n\n${content}` },
    ],
    temperature: 0.2,
    max_tokens: 1200,
  });

  return completion.choices?.[0]?.message?.content ?? "";
}

/**
 * Peer Simulation: act as a classmate to ask back/debate lightly.
 */
export async function peerSimulate(params: {
  materialText: string;
  style?: string; // e.g., "friendly", "challenging"
  rounds?: number;
}): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return "Server is missing GROQ_API_KEY.";
  const groq = new Groq({ apiKey });

  const style = params.style || "friendly";
  const rounds = Math.max(1, Math.min(5, Number(params.rounds || 1)));

  const prompt = `Simulate a peer/classmate discussion in a ${style} academic tone for ${rounds} turn(s).
Rules:
- Ask thoughtful questions based on materials and user's previous messages.
- Encourage critical thinking and academic communication.
- Keep it concise and constructive.`;

  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content:
          `Materials (context):\n---\n${clamp(params.materialText)}\n---\n\n` +
          prompt,
      },
    ],
    temperature: 0.4,
    max_tokens: 900,
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
  const groq = new Groq({ apiKey });

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

  const completion = await groq.chat.completions.create({
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
  const groq = new Groq({ apiKey });

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

  const completion = await groq.chat.completions.create({
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
