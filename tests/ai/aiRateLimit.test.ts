/**
 * AI rate limiter: sliding per-minute/per-hour windows, requests in flight,
 * keying, and its place in the middleware chain of every AI endpoint.
 * Groq is an in-memory fake; no database needed.
 */
import test, { after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import api, { stopBackgroundTasks } from "../../src/routes.js";
import config from "../../src/config/env.js";
import { aiRateLimiter, aiRateLimitKey } from "../../src/middleware/aiRateLimit.js";
import { guestIpLimiter } from "../../src/services/guestIpLimiter.js";
import { groqService } from "../../src/services/groqService.js";
import { GroqProvider } from "../../src/services/groqProvider.js";
import { completion, createFakeGroq, TEST_PROVIDER_CONFIG, type FakeHandler } from "./fakeGroq.js";

const saved = {
  aiRateLimitPerMinute: config.aiRateLimitPerMinute,
  aiRateLimitPerHour: config.aiRateLimitPerHour,
  aiMaxConcurrent: config.aiMaxConcurrent,
};
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let fake = createFakeGroq(() => completion("Penjelasan singkat."));

function useGroq(handler: FakeHandler) {
  fake = createFakeGroq(handler);
  (groqService as any).provider = new GroqProvider({ client: fake.client, config: TEST_PROVIDER_CONFIG });
}

beforeEach(() => {
  Object.assign(config, saved, { aiRateLimitPerMinute: 12, aiRateLimitPerHour: 150, aiMaxConcurrent: 2 });
  aiRateLimiter.reset();
  guestIpLimiter.reset();
  useGroq(() => completion("Penjelasan singkat."));
});

afterEach(() => Object.assign(config, saved));

after(() => {
  stopBackgroundTasks();
  setTimeout(() => process.exit(0), 100).unref();
});

/** Admit and immediately finish a request at time `now`. */
function hit(key: string, now: number) {
  const decision = aiRateLimiter.acquire(key, now);
  if (decision.allowed) aiRateLimiter.release(key);
  return decision;
}

// ---------------------------------------------------------------------------
// Limiter
// ---------------------------------------------------------------------------

test("allows the per-minute limit, then rejects with the time until a slot frees", () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 12; i++) assert.equal(hit("k", t0 + i * 1000).allowed, true, `request ${i + 1}`);

  const rejected = hit("k", t0 + 20_000);
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.allowed === false && rejected.reason, "minute");
  // The first request (t0) leaves the window at t0 + 60s
  assert.equal(rejected.allowed === false && rejected.retryAfterSeconds, 40);
});

test("the window slides: one old request expiring frees exactly one slot", () => {
  const t0 = 1_000_000;
  assert.equal(hit("k", t0).allowed, true);
  for (let i = 1; i < 12; i++) assert.equal(hit("k", t0 + 30_000 + i).allowed, true);

  assert.equal(hit("k", t0 + MINUTE - 1).allowed, false, "still inside the first request's minute");
  assert.equal(hit("k", t0 + MINUTE + 1).allowed, true, "first request has left the window");
  assert.equal(hit("k", t0 + MINUTE + 2).allowed, false, "the other 11 are still in the window");
});

test("rejected requests do not count, so retrying does not extend the wait", () => {
  config.aiRateLimitPerMinute = 2;
  const t0 = 1_000_000;
  hit("k", t0);
  hit("k", t0 + 1);
  for (let i = 0; i < 50; i++) assert.equal(hit("k", t0 + 1000 + i).allowed, false);
  assert.equal(hit("k", t0 + MINUTE + 2).allowed, true);
});

test("per-hour limit with its own retry time", () => {
  config.aiRateLimitPerMinute = 1_000;
  const t0 = 1_000_000;
  for (let i = 0; i < 150; i++) assert.equal(hit("k", t0 + i * 10_000).allowed, true);

  const rejected = hit("k", t0 + 1_500_000);
  assert.equal(rejected.allowed === false && rejected.reason, "hour");
  // First request (t0) leaves the hour window at t0 + 3600s
  assert.equal(rejected.allowed === false && rejected.retryAfterSeconds, 3600 - 1500);
  assert.equal(hit("k", t0 + HOUR + 1).allowed, true);
});

test("requests in flight are capped until one finishes", () => {
  const t0 = 1_000_000;
  assert.equal(aiRateLimiter.acquire("k", t0).allowed, true);
  assert.equal(aiRateLimiter.acquire("k", t0 + 1).allowed, true);

  const third = aiRateLimiter.acquire("k", t0 + 2);
  assert.equal(third.allowed === false && third.reason, "concurrency");

  aiRateLimiter.release("k");
  assert.equal(aiRateLimiter.acquire("k", t0 + 3).allowed, true);
});

test("each key has its own limits", () => {
  config.aiRateLimitPerMinute = 1;
  assert.equal(hit("user:a", 1_000).allowed, true);
  assert.equal(hit("user:a", 1_001).allowed, false);
  assert.equal(hit("user:b", 1_002).allowed, true);
});

test("cleanup drops idle keys but keeps busy ones", () => {
  const t0 = 1_000_000;
  hit("idle", t0);
  aiRateLimiter.acquire("busy", t0);
  assert.equal(aiRateLimiter.cleanup(t0 + 1000), 0, "idle key still has a request in the last hour");
  assert.equal(aiRateLimiter.cleanup(t0 + HOUR + 1), 1, "idle key removed, in-flight key kept");
  aiRateLimiter.release("busy");
  assert.equal(aiRateLimiter.cleanup(t0 + HOUR + 2), 1);
});

test("requests count against the account, else the guest device, else the IP", () => {
  const ctx = (opts: { user?: object; cookie?: string; ip?: string }): any => ({
    get: (name: string) => (name === "user" ? opts.user : undefined),
    req: {
      header: (name: string) => (name.toLowerCase() === "x-real-ip" ? opts.ip : undefined),
      raw: { headers: new Headers(opts.cookie ? { cookie: opts.cookie } : {}) },
    },
  });
  const device = randomUUID();
  assert.equal(aiRateLimitKey(ctx({ user: { id: "u1" }, cookie: `device_id=${device}`, ip: "203.0.113.1" })), "user:u1");
  assert.equal(aiRateLimitKey(ctx({ cookie: `device_id=${device}`, ip: "203.0.113.1" })), `device:${device}`);
  assert.equal(aiRateLimitKey(ctx({ cookie: "device_id=not-a-device-id", ip: "203.0.113.1" })), "ip:203.0.113.1");
  assert.equal(aiRateLimitKey(ctx({ ip: "203.0.113.1" })), "ip:203.0.113.1");
});

// ---------------------------------------------------------------------------
// Through the routes
// ---------------------------------------------------------------------------

let materialCounter = 0;
function material(): string {
  materialCounter++;
  return `Materi ${materialCounter}: Fotosintesis mengubah energi cahaya menjadi energi kimia di kloroplas.`;
}

async function call(path: string, body: unknown, device: string) {
  const res = await api.fetch(
    new Request(`http://local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `device_id=${device}`, "x-real-ip": "198.51.100.20" },
      body: JSON.stringify(body),
    })
  );
  return { status: res.status, body: (await res.json()) as any, retryAfter: res.headers.get("retry-after") };
}

const AI_ENDPOINTS = [
  "/explain",
  "/quiz",
  "/forum",
  "/exam",
  "/chat",
  "/quiz/trainer/mcq/start",
  "/flashcards",
  "/dialogue/start",
  "/dialogue/step",
  "/dialogue/hint",
  "/dialogue/feedback",
];

test("every AI endpoint is rate limited; MCQ scoring (no AI) is not", async () => {
  config.aiRateLimitPerMinute = 1;
  for (const path of AI_ENDPOINTS) {
    const device = randomUUID();
    await call(path, {}, device); // admitted (and rejected by validation), still counts
    const second = await call(path, {}, device);
    assert.equal(second.status, 429, `${path} should be rate limited`);
    assert.equal(second.body.code, "AI_RATE_LIMITED");
  }

  const device = randomUUID();
  for (let i = 0; i < 3; i++) {
    const res = await call("/quiz/trainer/mcq/score", { questions: [], userAnswers: {} }, device);
    assert.notEqual(res.status, 429);
  }
  assert.equal(fake.calls.length, 0, "no request reached Groq");
});

test("the 429 explains when to retry, in `error` and `answer`, with Retry-After", async () => {
  config.aiRateLimitPerMinute = 2;
  const device = randomUUID();
  assert.equal((await call("/explain", { materialText: material() }, device)).status, 200);
  assert.equal((await call("/explain", { materialText: material() }, device)).status, 200);

  const limited = await call("/explain", { materialText: material() }, device);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "AI_RATE_LIMITED");
  assert.match(limited.body.error, /Coba lagi dalam \d+ (detik|menit)/);
  assert.equal(limited.body.answer, limited.body.error);
  assert.ok(Number(limited.retryAfter) >= 1 && Number(limited.retryAfter) <= 60);
  assert.equal(limited.body.retryAfter, Number(limited.retryAfter));
  assert.equal(fake.calls.length, 2);
});

test("a rate-limited request does not use up a guest trial", async () => {
  config.aiRateLimitPerMinute = 3;
  const device = randomUUID();
  for (let i = 0; i < 3; i++) assert.equal((await call("/explain", { materialText: material() }, device)).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await call("/explain", { materialText: material() }, device)).status, 429);

  // Next minute: the guest still has 2 of 5 trial uses left
  aiRateLimiter.reset();
  assert.equal((await call("/explain", { materialText: material() }, device)).status, 200);
  assert.equal((await call("/explain", { materialText: material() }, device)).status, 200);
  const trialOver = await call("/explain", { materialText: material() }, device);
  assert.equal(trialOver.status, 401);
  assert.equal(trialOver.body.code, "GUEST_LIMIT_EXCEEDED");
});

test("a third parallel request is rejected at once instead of queueing for Groq", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  useGroq(async () => {
    await gate;
    return completion("Selesai.");
  });
  const device = randomUUID();

  const first = call("/explain", { materialText: material() }, device);
  const second = call("/explain", { materialText: material() }, device);
  // Let both reach the (blocked) Groq call
  for (let i = 0; i < 50 && fake.calls.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(fake.calls.length, 2);

  const third = await call("/explain", { materialText: material() }, device);
  assert.equal(third.status, 429);
  assert.equal(third.body.code, "AI_CONCURRENCY_LIMIT");
  assert.match(third.body.error, /masih diproses/);

  release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal((await call("/explain", { materialText: material() }, device)).status, 200, "slots are released");
});

test("a failed AI call still releases its slot", async () => {
  config.aiMaxConcurrent = 1;
  useGroq(() => {
    throw Object.assign(new Error("upstream down"), { status: 500 });
  });
  const device = randomUUID();
  for (let i = 0; i < 3; i++) {
    const res = await call("/flashcards", { materialText: material(), numCards: 3 }, device);
    assert.notEqual(res.status, 429, `attempt ${i + 1} must not be blocked by a leaked slot`);
  }
});
