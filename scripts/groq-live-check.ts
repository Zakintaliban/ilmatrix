/**
 * Live check of every AI study tool against the real Groq API.
 *
 *   GROQ_API_KEY=... npm run groq:check
 *
 * Run this before deploying a model or SDK change: it verifies that the
 * configured models exist, then calls each tool once with a short Indonesian
 * material and validates the response shape. Costs well under US$0.01.
 */
import Groq from "groq-sdk";
import config from "../src/config/env.js";
import { groqService } from "../src/services/groqService.js";

const MATERIAL = `Fotosintesis adalah proses tumbuhan hijau mengubah energi cahaya menjadi energi kimia.
Reaksi terang terjadi di membran tilakoid dan menghasilkan ATP serta NADPH.
Siklus Calvin terjadi di stroma dan menggunakan ATP dan NADPH untuk mengikat CO2 menjadi glukosa.`;

// Valid 32x32 grayscale PNG with a simple glyph pattern (enough to exercise the vision path)
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAAAAABWESUoAAAAKklEQVR42mP4TwAwjCgFDHAA4SGRRCtApoeIAiQfkalgqIYDpdE93PMFAN9jVNYpxnfhAAAAAElFTkSuQmCC";

type Check = { name: string; run: () => Promise<string> };

function expect(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const topics = [
  { id: 1, title: "Reaksi terang" },
  { id: 2, title: "Siklus Calvin" },
];

const checks: Check[] = [
  {
    name: "models available",
    run: async () => {
      const client = new Groq({ apiKey: config.groqApiKey });
      const list = await client.models.list();
      const ids = new Set(list.data.map((m: any) => m.id));
      const wanted = [config.groqModel, config.groqFallbackModel, config.groqVisionModel].filter(Boolean);
      const missing = wanted.filter((m) => !ids.has(m));
      expect(!missing.length, `not available to this key: ${missing.join(", ")}`);
      return wanted.join(", ");
    },
  },
  ...(["explain", "quiz", "forum", "exam"] as const).map((task) => ({
    name: task,
    run: async () => {
      const answer = await groqService.generateAnswer({ materialText: MATERIAL, task, prompt: "Jelaskan singkat." });
      expect(answer && !answer.startsWith("I encountered an error"), answer);
      return answer.slice(0, 60);
    },
  })),
  {
    name: "chat",
    run: async () => {
      const answer = await groqService.generateChat({
        materialText: MATERIAL,
        messages: [{ role: "user", content: "Di mana siklus Calvin terjadi?" }],
      });
      expect(/stroma/i.test(answer), `unexpected answer: ${answer}`);
      return answer.slice(0, 60);
    },
  },
  {
    name: "mcq trainer",
    run: async () => {
      const questions = await groqService.generateQuizTrainerMCQ({ materialText: MATERIAL, numQuestions: 2 });
      expect(questions.length === 2, `expected 2 questions, got ${questions.length}`);
      expect(questions.every((q) => q.options.length === 5 && /^[A-E]$/.test(q.answer)), "bad question shape");
      return questions[0].question.slice(0, 60);
    },
  },
  {
    name: "flashcards",
    run: async () => {
      const cards = await groqService.generateFlashcards({ materialText: MATERIAL, numCards: 3 });
      expect(cards.length >= 1 && cards.every((c) => c.front && c.back), "bad cards");
      return `${cards.length} cards`;
    },
  },
  {
    name: "dialogue start",
    run: async () => {
      const r = await groqService.dialogueStart({ materialText: MATERIAL });
      expect(r.topics.length >= 1 && r.firstCoachPrompt, "bad dialogue start");
      return r.firstCoachPrompt.slice(0, 60);
    },
  },
  {
    name: "dialogue step",
    run: async () => {
      const r = await groqService.dialogueStep({
        materialText: MATERIAL,
        topics,
        currentTopicIndex: 0,
        userMessage: "Reaksi terang menghasilkan ATP dan NADPH di tilakoid.",
        language: "id",
      });
      expect(typeof r.addressed === "boolean" && r.coachMessage, "bad dialogue step");
      return r.coachMessage.slice(0, 60);
    },
  },
  {
    name: "dialogue hint",
    run: async () => (await groqService.dialogueHint({ materialText: MATERIAL, currentTopicTitle: "Siklus Calvin", language: "id" })).hint.slice(0, 60),
  },
  {
    name: "dialogue feedback",
    run: async () => {
      const r = await groqService.dialogueFeedback({ materialText: MATERIAL, topics, language: "id" });
      expect(r.feedback, "empty feedback");
      return r.feedback.slice(0, 60);
    },
  },
  {
    // Confirms the assumptions the streaming endpoints rely on: text arrives as
    // content deltas, reasoning stays hidden, and usage comes in the final chunk
    // (x_groq.usage). If usage is missing, streams are billed by estimate.
    name: "streaming (raw)",
    run: async () => {
      const client = new Groq({ apiKey: config.groqApiKey, timeout: config.groqTimeoutMs, maxRetries: 0 });
      const stream = await client.chat.completions.create({
        model: config.groqModel,
        messages: [{ role: "user", content: "Sebutkan tiga tahap fotosintesis dalam satu kalimat." }],
        stream: true,
        include_reasoning: false,
        reasoning_effort: "low",
        max_completion_tokens: 600,
      } as any);
      let deltas = 0;
      let reasoningDeltas = 0;
      let usage: any = null;
      let usageWhere = "none";
      for await (const chunk of stream as any) {
        if (chunk.choices?.[0]?.delta?.content) deltas++;
        if (chunk.choices?.[0]?.delta?.reasoning) reasoningDeltas++;
        if (chunk.x_groq?.usage) [usage, usageWhere] = [chunk.x_groq.usage, "x_groq.usage"];
        else if (chunk.usage) [usage, usageWhere] = [chunk.usage, "usage"];
      }
      expect(deltas > 1, `expected several content deltas, got ${deltas}`);
      expect(reasoningDeltas === 0, `reasoning leaked into the stream (${reasoningDeltas} deltas)`);
      expect(usage?.total_tokens > 0, "no usage in the stream: streamed answers will be billed by estimate");
      return `${deltas} deltas, usage in ${usageWhere} (${usage.total_tokens} tok)`;
    },
  },
  {
    name: "streaming (service)",
    run: async () => {
      let pieces = 0;
      const result = await groqService.streamChat(
        { materialText: MATERIAL, messages: [{ role: "user", content: "Di mana reaksi terang terjadi?" }] },
        { onDelta: () => pieces++ }
      );
      expect(result.content && pieces > 1, `stream produced ${pieces} pieces`);
      expect(!result.estimated, "usage was estimated, not reported by Groq");
      return `${pieces} pieces, ${result.content.slice(0, 40)}`;
    },
  },
  {
    name: "vision OCR",
    run: async () => {
      if (!config.groqVisionModel) return "skipped (GROQ_VISION_MODEL empty)";
      const text = await groqService.extractTextFromImage(TINY_PNG);
      return `ok (${text.length} chars)`;
    },
  },
];

async function main() {
  if (!config.groqApiKey) {
    console.error("GROQ_API_KEY is not set.");
    process.exit(1);
  }
  console.log(`Primary: ${config.groqModel} | fallback: ${config.groqFallbackModel || "-"} | vision: ${config.groqVisionModel || "-"}\n`);

  let failed = 0;
  for (const check of checks) {
    const started = Date.now();
    try {
      const { result, usage, model } = await groqService.track(check.run);
      const tokens = usage ? `${usage.total_tokens} tok` : "";
      console.log(`✓ ${check.name.padEnd(18)} ${String(Date.now() - started).padStart(5)}ms ${tokens.padStart(9)} ${model || ""}  ${result}`);
    } catch (error) {
      failed++;
      console.log(`✗ ${check.name.padEnd(18)} ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
}

main();
