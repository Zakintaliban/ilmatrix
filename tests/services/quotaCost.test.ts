/**
 * Inference cost accounting and quota policy that need no database:
 * kredit pricing, reservation estimates, limit precedence and cost observation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import config from "../../src/config/env.js";
import { KREDIT_PRODUCTS, PLANS } from "../../src/config/plans.js";
import { kreditForUsage, pricesFromEnv } from "../../src/config/inferenceCost.js";
import { reservationKredit } from "../../src/services/quotaEstimates.js";
import { quotaSummary, resolveLimits, type QuotaDefaults } from "../../src/services/quotaService.js";
import { GroqProvider, observeCost, trackUsage } from "../../src/services/groqProvider.js";
import { OUTPUT_CAPS } from "../../src/services/groqService.js";
import { apiError, completion, createFakeGroq, TEST_PROVIDER_CONFIG } from "../ai/fakeGroq.js";

test("kredit is priced per model (1 kredit ~ Rp4 of AI cost)", () => {
  // Typical grounded answer on gpt-oss-120b: 8k in / 1.5k out = US$0.0021
  assert.equal(kreditForUsage("openai/gpt-oss-120b", 8000, 1500), 9.45);
  // The fallback model costs half
  assert.equal(kreditForUsage("openai/gpt-oss-20b", 8000, 1500), 4.73);
  // A photo on the vision model: 2.5k in / 1.5k out = US$0.008
  assert.equal(kreditForUsage("qwen/qwen3.8-27b", 2500, 1500), 36);
  // Llama 4 Maverick on Vertex AI: 8k in / 1.5k out = US$0.004525
  assert.equal(kreditForUsage("meta/llama-4-maverick-17b-128e-instruct-maas", 8000, 1500), 20.37);
  assert.equal(kreditForUsage("openai/gpt-oss-120b", 0, 0), 0);
});

test("unknown models are charged at the most expensive known rate", () => {
  assert.equal(kreditForUsage("some/new-model", 2500, 1500), kreditForUsage("qwen/qwen3.8-27b", 2500, 1500));
});

test("AI_MODEL_PRICES adds prices for new hosts and rejects bad entries", () => {
  assert.deepEqual(pricesFromEnv('{"acme/model":{"input":0.1,"output":0.2},"bad":{"input":-1,"output":1},"half":{"input":1}}'), {
    "acme/model": { input: 0.1, output: 0.2 },
  });
  assert.deepEqual(pricesFromEnv("not json"), {});
  assert.deepEqual(pricesFromEnv(undefined), {});
});

test("plan catalogue is kept as it was (payments are postponed, not rebalanced)", () => {
  assert.deepEqual(
    Object.values(PLANS).map((p) => [p.code, p.weeklyKredit, p.priceIdr]),
    [
      ["free", 150, 0],
      ["bulanan", 900, 29_000],
      ["semester", 700, 99_000],
    ]
  );
  assert.deepEqual(KREDIT_PRODUCTS.pass_7d, { code: "pass_7d", name: "Pass 7 Hari", kredit: 1_000, priceIdr: 9_900, validDays: 7 });
});

test("usage tracking prices each call by the model that served it", async () => {
  const fake = createFakeGroq((params) => {
    if (params.model === "openai/gpt-oss-120b") throw apiError(429, "Rate limit reached");
    return completion("ok", { prompt: 8000, completion: 1500 });
  });
  const provider = new GroqProvider({ client: fake.client, config: TEST_PROVIDER_CONFIG });
  const { kredit, model } = await trackUsage(() => provider.complete({ messages: [] }));
  assert.equal(model, "openai/gpt-oss-20b");
  assert.equal(kredit, 4.73, "billed at the fallback model's (cheaper) rate");
});

test("the cost observer counts what was spent even when the caller then fails", async () => {
  const fake = createFakeGroq(() => completion("ok", { prompt: 8000, completion: 1500 }));
  const provider = new GroqProvider({ client: fake.client, config: TEST_PROVIDER_CONFIG });
  const sink = { kredit: 0 };
  await assert.rejects(
    observeCost(sink, async () => {
      await provider.complete({ messages: [] });
      throw new Error("post-processing failed");
    })
  );
  assert.equal(sink.kredit, 9.45);
});

function withModel<T>(overrides: Partial<typeof config>, fn: () => T): T {
  const saved = { ...config };
  Object.assign(config, overrides);
  try {
    return fn();
  } finally {
    Object.assign(config, saved);
  }
}

test("reservations price the tool's token budget with the configured model and its real output cap", () => {
  withModel({ groqModel: "openai/gpt-oss-120b", groqFallbackModel: "openai/gpt-oss-20b", groqReasoningEffort: "medium", aiBaseUrl: "" }, () => {
    // gpt-oss reasons: the cap is the visible answer plus 2,048 reasoning tokens (medium)
    assert.equal(reservationKredit("explain"), kreditForUsage("openai/gpt-oss-120b", 12_000, OUTPUT_CAPS.answer + 2048));
  });
  // Llama 4 Maverick on Vertex: no reasoning headroom, Vertex's price, nothing Groq-specific
  withModel(
    {
      groqModel: "meta/llama-4-maverick-17b-128e-instruct-maas",
      groqFallbackModel: "",
      groqVisionModel: "meta/llama-4-maverick-17b-128e-instruct-maas",
      aiBaseUrl: "https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5/endpoints/openapi",
    },
    () => {
      assert.equal(reservationKredit("explain"), kreditForUsage("meta/llama-4-maverick-17b-128e-instruct-maas", 12_000, OUTPUT_CAPS.answer));
      assert.equal(reservationKredit("ocr", { images: 2 }), 2 * kreditForUsage("meta/llama-4-maverick-17b-128e-instruct-maas", 2_000, OUTPUT_CAPS.ocr));
    }
  );
});

test("reservations follow the requested size and the priciest model that may answer", () => {
  assert.ok(reservationKredit("mcq", { count: 50 }) > reservationKredit("mcq", { count: 5 }));
  assert.ok(reservationKredit("flashcards", { count: 50 }) > reservationKredit("flashcards", { count: 10 }));
  withModel({ groqModel: "openai/gpt-oss-20b", groqFallbackModel: "openai/gpt-oss-120b" }, () => {
    assert.equal(
      reservationKredit("dialogue"),
      kreditForUsage("openai/gpt-oss-120b", 8_000, OUTPUT_CAPS.dialogue + 1024),
      "a pricier fallback model sets the reservation"
    );
  });
});

const defaults: QuotaDefaults = { daily: 100, weekly: 500, dailySource: "env", weeklySource: "admin", updatedAt: null };

test("limits: a per-user override beats a paid plan, which beats the global default", () => {
  const user = { daily_kredit_override: null, weekly_kredit_override: null };
  assert.deepEqual(resolveLimits(user, defaults, null), { daily: 100, dailySource: "env", weekly: 500, weeklySource: "admin" });
  // Entitlements are only passed while payments are enabled; then an active paid plan sets the weekly quota
  assert.equal(resolveLimits(user, defaults, { weeklyLimit: 700 }).weekly, 700);
  assert.equal(resolveLimits(user, defaults, { weeklyLimit: 700 }).weeklySource, "plan");
  const overridden = resolveLimits({ daily_kredit_override: "20", weekly_kredit_override: "0" }, defaults, { weeklyLimit: 700 });
  assert.deepEqual(overridden, { daily: 20, dailySource: "user", weekly: 0, weeklySource: "user" });
});

test("the summary counts running reservations as used", () => {
  const window = (used: number, reserved: number, limit: number) => ({
    used,
    reserved,
    limit,
    remaining: Math.max(0, limit - used - reserved),
    periodStart: "2026-11-18",
    resetsAt: new Date("2026-11-18T17:00:00Z"),
    limitSource: "env" as const,
  });
  const summary = quotaSummary({
    timezone: "Asia/Jakarta",
    daily: window(60, 20, 100),
    weekly: window(600, 0, 500),
    exempt: false,
    accessEnabled: true,
    payments: null,
  });
  assert.equal(summary.daily.percentage, 80);
  assert.equal(summary.weekly.percentage, 100, "capped at 100");
  assert.equal("payments" in summary, false, "no plan or extra kredit while payments are off");
});
