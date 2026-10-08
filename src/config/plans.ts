/**
 * Plans, kredit products and model pricing.
 *
 * Kredit is the unit students see. It is cost-weighted: 1 kredit is about
 * Rp4 of AI cost (US$1 = 4,500 kredit at Rp18,000/USD), so every plan's
 * allowance is also its worst-case AI cost. See docs/AUDIT_AND_STRATEGY_2026.md
 * §16-17 for the pricing rationale.
 */

export type PlanCode = "free" | "bulanan" | "semester";

export interface Plan {
  code: PlanCode;
  name: string;
  /** Kredit available each week (resets Monday 00:00 UTC). */
  weeklyKredit: number;
  priceIdr: number;
  /** Length of a paid period; null = does not expire. */
  durationDays: number | null;
}

function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const PLANS: Record<PlanCode, Plan> = {
  free: {
    code: "free",
    name: "Gratis",
    weeklyKredit: envNumber("KREDIT_FREE_WEEKLY", 150),
    priceIdr: 0,
    durationDays: null,
  },
  bulanan: { code: "bulanan", name: "Bulanan", weeklyKredit: 900, priceIdr: 29_000, durationDays: 30 },
  semester: { code: "semester", name: "Semester", weeklyKredit: 700, priceIdr: 99_000, durationDays: 182 },
};

export function isPlanCode(value: unknown): value is PlanCode {
  return typeof value === "string" && value in PLANS;
}

export type KreditProductCode = "pass_7d" | "topup";

export interface KreditProduct {
  code: KreditProductCode;
  name: string;
  kredit: number;
  priceIdr: number;
  /** Validity after purchase; null = never expires. */
  validDays: number | null;
}

/** One-off kredit, used after the weekly allowance. */
export const KREDIT_PRODUCTS: Record<KreditProductCode, KreditProduct> = {
  pass_7d: { code: "pass_7d", name: "Pass 7 Hari", kredit: 1_000, priceIdr: 9_900, validDays: 7 },
  topup: { code: "topup", name: "Top-up", kredit: 600, priceIdr: 5_000, validDays: 90 },
};

export function isKreditProductCode(value: unknown): value is KreditProductCode {
  return typeof value === "string" && value in KREDIT_PRODUCTS;
}

// ---------------------------------------------------------------------------
// Pricing: tokens -> kredit
// ---------------------------------------------------------------------------

/** US$1 of Groq cost in kredit (1 kredit ~ Rp4 at Rp18,000/USD). */
export const KREDIT_PER_USD = 4_500;

/** Groq on-demand prices in US$ per million tokens (October 2026). */
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  "openai/gpt-oss-120b": { input: 0.15, output: 0.6 },
  "openai/gpt-oss-20b": { input: 0.075, output: 0.3 },
  "qwen/qwen3.8-27b": { input: 0.8, output: 4.0 },
};

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
      console.warn(`[KREDIT] No price for model "${model}"; charging the highest known rate`);
    }
    price = FALLBACK_PRICE;
  }
  const usd = (promptTokens * price.input + completionTokens * price.output) / 1_000_000;
  // Trim floating-point noise (e.g. 945.0000000001) before rounding up to 0.01
  const hundredths = Number((usd * KREDIT_PER_USD * 100).toFixed(6));
  return Math.ceil(hundredths) / 100;
}
