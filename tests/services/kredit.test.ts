import test from "node:test";
import assert from "node:assert/strict";
import { KREDIT_PRODUCTS, PLANS, kreditForUsage } from "../../src/config/plans.js";
import { buildStatus, canUseAI } from "../../src/services/kreditService.js";
import { GroqProvider, trackUsage } from "../../src/services/groqProvider.js";
import { apiError, completion, createFakeGroq, TEST_PROVIDER_CONFIG } from "../ai/fakeGroq.js";

test("kredit is priced per model (1 kredit ~ Rp4 of AI cost)", () => {
  // Typical grounded answer on gpt-oss-120b: 8k in / 1.5k out = US$0.0021
  assert.equal(kreditForUsage("openai/gpt-oss-120b", 8000, 1500), 9.45);
  // The fallback model costs half
  assert.equal(kreditForUsage("openai/gpt-oss-20b", 8000, 1500), 4.73);
  // A photo on the vision model: 2.5k in / 1.5k out = US$0.008
  assert.equal(kreditForUsage("qwen/qwen3.8-27b", 2500, 1500), 36);
  assert.equal(kreditForUsage("openai/gpt-oss-120b", 0, 0), 0);
});

test("unknown models are charged at the most expensive known rate", () => {
  assert.equal(kreditForUsage("some/new-model", 2500, 1500), kreditForUsage("qwen/qwen3.8-27b", 2500, 1500));
});

test("plan catalogue matches the approved pricing", () => {
  assert.deepEqual(
    Object.values(PLANS).map((p) => [p.code, p.weeklyKredit, p.priceIdr]),
    [
      ["free", 150, 0],
      ["bulanan", 900, 29_000],
      ["semester", 700, 99_000],
    ]
  );
  assert.deepEqual(KREDIT_PRODUCTS.pass_7d, { code: "pass_7d", name: "Pass 7 Hari", kredit: 1_000, priceIdr: 9_900, validDays: 7 });
  // Worst-case AI cost of each allowance stays below its price (1 kredit = Rp4)
  assert.ok(KREDIT_PRODUCTS.pass_7d.kredit * 4 < KREDIT_PRODUCTS.pass_7d.priceIdr);
  assert.ok(PLANS.bulanan.weeklyKredit * 4 * 4.35 < PLANS.bulanan.priceIdr);
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

const baseUser = {
  plan: "free",
  plan_expires_at: null,
  weekly_kredit_used: "40.50",
  monthly_kredit_used: "100",
  weekly_kredit_override: null,
  weekly_usage_reset_at: new Date(Date.now() + 86_400_000),
  monthly_usage_reset_at: new Date(Date.now() + 86_400_000),
  is_admin: false,
  token_access_enabled: true,
};

test("status combines the weekly allowance with active grants", () => {
  const status = buildStatus(baseUser, [{ id: "g1", source: "pass_7d", remaining: "500", expires_at: null }]);
  assert.equal(status.plan, "free");
  assert.equal(status.weeklyLimit, 150);
  assert.equal(status.weeklyRemaining, 109.5);
  assert.equal(status.extraRemaining, 500);
  assert.equal(status.totalRemaining, 609.5);
  assert.equal(canUseAI(status), true);
});

test("an expired paid plan falls back to the free allowance", () => {
  const active = buildStatus({ ...baseUser, plan: "semester", plan_expires_at: new Date(Date.now() + 86_400_000) }, []);
  assert.equal(active.plan, "semester");
  assert.equal(active.weeklyLimit, 700);

  const expired = buildStatus({ ...baseUser, plan: "semester", plan_expires_at: new Date(Date.now() - 1000) }, []);
  assert.equal(expired.plan, "free");
  assert.equal(expired.weeklyLimit, 150);
  assert.equal(expired.planExpiresAt, null);
});

test("an admin override replaces the plan's weekly allowance", () => {
  assert.equal(buildStatus({ ...baseUser, weekly_kredit_override: "20" }, []).weeklyLimit, 20);
});

test("no kredit left blocks AI, except for admins; disabled access always blocks", () => {
  const exhausted = buildStatus({ ...baseUser, weekly_kredit_used: "151" }, []);
  assert.equal(exhausted.totalRemaining, 0);
  assert.equal(canUseAI(exhausted), false);
  assert.equal(canUseAI({ ...exhausted, isAdmin: true }), true);
  assert.equal(canUseAI(buildStatus({ ...baseUser, token_access_enabled: false }, [])), false);
});
