/**
 * How much kredit to reserve before an AI tool runs.
 *
 * Provider-agnostic: a per-tool token budget is priced with the model(s)
 * configured for that tool (inferenceCost.ts), and the output part is the
 * exact cap the provider sends for that model (OUTPUT_CAPS plus reasoning
 * headroom). Switching hosts or models changes the estimates automatically.
 *
 * Inputs are budgeted, not measured: a request whose prompt is larger than
 * its budget (very long material, a long chat) or that is answered from
 * images by a pricier vision model can cost more than it reserved. That is
 * the only way a quota can be exceeded, and only by that difference.
 */
import config from "../config/env.js";
import { kreditForUsage } from "../config/inferenceCost.js";
import { buildParams, type ProviderConfig, type ReasoningEffort } from "./groqProvider.js";
import { OUTPUT_CAPS } from "./groqService.js";
import type { QuotaTool } from "./quotaService.js";

/** Prompt tokens per request: instructions plus a typical lecture's worth of material (~48k characters). */
const INPUT_TOKENS: Record<QuotaTool, number> = {
  explain: 12_000,
  quiz: 12_000,
  forum: 12_000,
  exam: 12_000,
  chat: 16_000, // material plus conversation history
  mcq: 12_000,
  flashcards: 12_000,
  dialogue: 8_000,
  ocr: 2_000, // per image
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function providerConfig(): ProviderConfig {
  return {
    apiKey: "",
    baseURL: config.aiBaseUrl,
    model: config.groqModel,
    fallbackModel: config.groqFallbackModel,
    visionModel: config.groqVisionModel,
    reasoningEffort: config.groqReasoningEffort,
    structuredOutputs: config.groqStructuredOutputs,
    timeoutMs: config.groqTimeoutMs,
    concurrency: config.groqConcurrency,
  };
}

/** Kredit for one call on the priciest model that may serve it, at the output cap the provider will send. */
function callKredit(models: string[], inputTokens: number, maxOutputTokens: number, effort?: ReasoningEffort): number {
  const cfg = providerConfig();
  return Math.max(
    ...models.filter(Boolean).map((model) => {
      const params = buildParams(model, { messages: [], maxOutputTokens, reasoningEffort: effort }, cfg);
      const outputCap = params.max_completion_tokens ?? params.max_tokens ?? maxOutputTokens;
      return kreditForUsage(model, inputTokens, outputCap);
    })
  );
}

/**
 * Kredit to reserve for one request.
 * `count`: questions (mcq) or cards (flashcards) requested; `images`: images to OCR.
 */
export function reservationKredit(tool: QuotaTool, opts: { count?: number; images?: number } = {}): number {
  const text = [config.groqModel, config.groqFallbackModel];
  // Material is clamped before it reaches the model, so budgets never exceed that
  const input = Math.min(INPUT_TOKENS[tool], Math.ceil(config.materialClamp / 4) + 2_000);
  switch (tool) {
    case "ocr":
      return round2(
        Math.max(1, opts.images ?? 1) * callKredit([config.groqVisionModel || config.groqModel], INPUT_TOKENS.ocr, OUTPUT_CAPS.ocr, "none")
      );
    case "mcq":
      return round2(callKredit(text, input, OUTPUT_CAPS.mcq(opts.count ?? 5), "low"));
    case "flashcards":
      return round2(callKredit(text, input, OUTPUT_CAPS.flashcards(opts.count ?? 10), "low"));
    case "dialogue":
      return round2(callKredit(text, input, OUTPUT_CAPS.dialogue, "low"));
    default:
      return round2(callKredit(text, input, OUTPUT_CAPS.answer));
  }
}

/** Reservation per tool with default settings, shown to students as "up to ~N kredit". */
export function reservationTable(): Record<QuotaTool, number> {
  const tools: QuotaTool[] = ["explain", "quiz", "forum", "exam", "chat", "mcq", "flashcards", "dialogue", "ocr"];
  return Object.fromEntries(tools.map((t) => [t, reservationKredit(t)])) as Record<QuotaTool, number>;
}
