/**
 * Inference cost accounting: tokens -> kredit.
 *
 * Kredit is a provider-neutral unit of AI cost (US$1 = 4,500 kredit, so
 * 1 kredit is about Rp4). Each completion is priced by the model that served
 * it, whatever the host (Groq, DeepInfra, Vertex AI, ...). Quota policy
 * (src/services/quotaService.ts) only ever sees kredit, never model names.
 *
 * AI_MODEL_PRICES adds or replaces prices without a code change, e.g. when
 * moving hosts: {"meta/llama-4-maverick-17b-128e-instruct-maas":{"input":0.35,"output":1.15}}
 */

export const KREDIT_PER_USD = 4_500;

export type ModelPrice = { input: number; output: number };

/** On-demand prices in US$ per million tokens: Groq (October 2026), DeepInfra and Vertex AI (November 2026). */
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "openai/gpt-oss-120b": { input: 0.15, output: 0.6 },
  "openai/gpt-oss-20b": { input: 0.075, output: 0.3 },
  "qwen/qwen3.8-27b": { input: 0.8, output: 4.0 },
  "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8": { input: 0.2, output: 0.8 },
  "meta/llama-4-maverick-17b-128e-instruct-maas": { input: 0.35, output: 1.15 },
};

/** Parse AI_MODEL_PRICES (exported for tests). */
export function pricesFromEnv(raw: string | undefined): Record<string, ModelPrice> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    const valid: Record<string, ModelPrice> = {};
    for (const [model, price] of Object.entries(parsed ?? {})) {
      const { input, output } = (price ?? {}) as Partial<ModelPrice>;
      if (typeof input === "number" && typeof output === "number" && input >= 0 && output >= 0) {
        valid[model] = { input, output };
      } else {
        console.warn(`[KREDIT] Ignoring AI_MODEL_PRICES entry for "${model}": needs non-negative input and output`);
      }
    }
    return valid;
  } catch {
    console.warn("[KREDIT] AI_MODEL_PRICES is not valid JSON; using the built-in prices");
    return {};
  }
}

export const MODEL_PRICES: Record<string, ModelPrice> = { ...DEFAULT_PRICES, ...pricesFromEnv(process.env.AI_MODEL_PRICES) };

// Unknown models are charged at the most expensive known rate
const FALLBACK_PRICE = Object.values(MODEL_PRICES).reduce((max, p) =>
  p.input + p.output > max.input + max.output ? p : max
);
const warnedModels = new Set<string>();

/** Kredit for one completion, rounded up to 0.01. */
export function kreditForUsage(model: string, promptTokens: number, completionTokens: number): number {
  let price = MODEL_PRICES[model];
  if (!price) {
    if (!warnedModels.has(model)) {
      warnedModels.add(model);
      console.warn(`[KREDIT] No price for model "${model}"; charging the highest known rate (set AI_MODEL_PRICES)`);
    }
    price = FALLBACK_PRICE;
  }
  const usd = (promptTokens * price.input + completionTokens * price.output) / 1_000_000;
  // Trim floating-point noise (e.g. 945.0000000001) before rounding up to 0.01
  const hundredths = Number((usd * KREDIT_PER_USD * 100).toFixed(6));
  return Math.ceil(hundredths) / 100;
}
