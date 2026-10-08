/**
 * Guest abuse protection: Turnstile device verification, per-IP daily caps and
 * trusted client-IP resolution, exercised through the real Hono routes with
 * Groq and Cloudflare siteverify replaced by in-memory fakes. No database needed.
 */
import test, { after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import api, { stopBackgroundTasks } from "../../src/routes.js";
import config from "../../src/config/env.js";
import { groqService } from "../../src/services/groqService.js";
import { GroqProvider } from "../../src/services/groqProvider.js";
import { guestIpLimiter } from "../../src/services/guestIpLimiter.js";
import { aiRateLimiter } from "../../src/middleware/aiRateLimit.js";
import { setTurnstileVerifier, type TurnstileVerifier } from "../../src/services/turnstileService.js";
import { getClientIp } from "../../src/utils/security.js";
import { completion, createFakeGroq, TEST_PROVIDER_CONFIG } from "./fakeGroq.js";

const GOOD_TOKEN = "good-token";
const saved = {
  turnstileSiteKey: config.turnstileSiteKey,
  turnstileSecretKey: config.turnstileSecretKey,
  guestIpDailyVerifications: config.guestIpDailyVerifications,
  guestIpDailyRequests: config.guestIpDailyRequests,
  clientIpHeader: config.clientIpHeader,
};

let fake = createFakeGroq(() => completion("Penjelasan singkat."));
let verifierCalls: Parameters<TurnstileVerifier>[0][] = [];
let ipCounter = 0;

const fakeVerifier: TurnstileVerifier = async (params) => {
  verifierCalls.push(params);
  return params.token === GOOD_TOKEN
    ? { success: true, errorCodes: [] }
    : { success: false, errorCodes: ["invalid-input-response"] };
};

function enableTurnstile() {
  config.turnstileSiteKey = "test-site-key";
  config.turnstileSecretKey = "test-secret-key";
}

beforeEach(() => {
  fake = createFakeGroq(() => completion("Penjelasan singkat."));
  (groqService as any).provider = new GroqProvider({ client: fake.client, config: TEST_PROVIDER_CONFIG });
  verifierCalls = [];
  setTurnstileVerifier(fakeVerifier);
  guestIpLimiter.reset();
  aiRateLimiter.reset();
  Object.assign(config, saved, { clientIpHeader: "x-real-ip" });
});

afterEach(() => {
  setTurnstileVerifier(null);
  Object.assign(config, saved);
});

after(() => {
  stopBackgroundTasks();
  setTimeout(() => process.exit(0), 100).unref();
});

/** A fresh documentation-range IP per call, so tests never share caps by accident. */
function newIp(): string {
  ipCounter++;
  return `203.0.113.${ipCounter}`;
}

let materialCounter = 0;
function material(): string {
  materialCounter++;
  return `Materi ${materialCounter}: Fotosintesis mengubah energi cahaya menjadi energi kimia di kloroplas.`;
}

interface CallOptions {
  ip?: string;
  device?: string;
  headers?: Record<string, string>;
}

async function call(path: string, body: unknown, opts: CallOptions = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...opts.headers };
  if (opts.ip) headers["x-real-ip"] = opts.ip;
  if (opts.device) headers.cookie = `device_id=${opts.device}`;
  const res = await api.fetch(
    new Request(`http://local${path}`, { method: "POST", headers, body: JSON.stringify(body) })
  );
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { __raw: text };
  }
  const device = res.headers.get("set-cookie")?.match(/device_id=([^;]+)/)?.[1];
  return { status: res.status, body: json, device };
}

const explain = (opts: CallOptions) => call("/explain", { materialText: material() }, opts);

/** Fresh device that has passed Turnstile from `ip`. */
async function verifiedDevice(ip: string): Promise<string> {
  const res = await call("/guest/verify", { token: GOOD_TOKEN }, { ip });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.device, "verification should set the device cookie");
  return res.device!;
}

// ---------------------------------------------------------------------------
// Turnstile disabled (no keys): behaviour unchanged
// ---------------------------------------------------------------------------

test("without Turnstile keys guests use tools as before and /guest/verify is a no-op", async () => {
  const ip = newIp();
  const res = await explain({ ip });
  assert.equal(res.status, 200);
  assert.equal(fake.calls.length, 1);

  const verify = await call("/guest/verify", {}, { ip });
  assert.equal(verify.status, 200);
  assert.deepEqual(verify.body, { ok: true, verification: "disabled" });
  assert.equal(verifierCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Device verification
// ---------------------------------------------------------------------------

test("an unverified guest is asked to verify before any Groq call", async () => {
  enableTurnstile();
  const res = await explain({ ip: newIp() });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "GUEST_VERIFICATION_REQUIRED");
  assert.equal(res.body.turnstile_site_key, "test-site-key");
  assert.equal(res.body.requiresAuth, false);
  assert.ok(res.body.answer, "message is shown by tools that render `answer`");
  assert.ok(res.device, "the 401 sets a device cookie so verification can attach to it");
  assert.equal(fake.calls.length, 0);
});

test("after verification the same device can use the tools", async () => {
  enableTurnstile();
  const ip = newIp();
  const first = await explain({ ip });
  assert.equal(first.status, 401);

  const verify = await call("/guest/verify", { token: GOOD_TOKEN }, { ip, device: first.device });
  assert.equal(verify.status, 200);
  assert.deepEqual(verify.body, { ok: true });

  const retry = await explain({ ip, device: first.device });
  assert.equal(retry.status, 200);
  assert.equal(fake.calls.length, 1);
});

test("the verifier gets the secret, the client IP and a fresh idempotency key", async () => {
  enableTurnstile();
  const ip = newIp();
  await verifiedDevice(ip);
  await verifiedDevice(ip);

  assert.equal(verifierCalls.length, 2);
  for (const params of verifierCalls) {
    assert.equal(params.secret, "test-secret-key");
    assert.equal(params.token, GOOD_TOKEN);
    assert.equal(params.remoteIp, ip);
    assert.match(params.idempotencyKey, /^[0-9a-f-]{36}$/);
  }
  assert.notEqual(verifierCalls[0].idempotencyKey, verifierCalls[1].idempotencyKey);
});

test("dropping the device cookie does not bypass verification", async () => {
  enableTurnstile();
  const ip = newIp();
  const device = await verifiedDevice(ip);
  assert.equal((await explain({ ip, device })).status, 200);

  for (let i = 0; i < 3; i++) {
    const res = await explain({ ip });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, "GUEST_VERIFICATION_REQUIRED");
  }
  assert.equal(fake.calls.length, 1);
});

test("a session cookie that cannot be looked up is treated as a guest, not let through", async () => {
  enableTurnstile();
  // No database in this suite, so the lookup throws (it used to skip all limits)
  const res = await explain({ ip: newIp(), headers: { cookie: "session=not-a-real-session" } });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "GUEST_VERIFICATION_REQUIRED");
  assert.equal(fake.calls.length, 0);
});

test("an invalid token is rejected and does not verify the device", async () => {
  enableTurnstile();
  const ip = newIp();
  const verify = await call("/guest/verify", { token: "forged" }, { ip });
  assert.equal(verify.status, 403);
  assert.equal(verify.body.code, "TURNSTILE_FAILED");
  assert.deepEqual(verify.body.error_codes, ["invalid-input-response"]);

  const res = await explain({ ip, device: verify.device });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "GUEST_VERIFICATION_REQUIRED");
});

test("missing or oversized tokens never reach siteverify", async () => {
  enableTurnstile();
  for (const body of [{}, { token: "" }, { token: 42 }, { token: "x".repeat(2049) }]) {
    const res = await call("/guest/verify", body, { ip: newIp() });
    assert.equal(res.status, 403);
    assert.deepEqual(res.body.error_codes, ["missing-input-response"]);
  }
  const malformed = await api.fetch(
    new Request("http://local/guest/verify", { method: "POST", headers: { "content-type": "application/json" }, body: "{" })
  );
  assert.equal(malformed.status, 403);
  assert.equal(verifierCalls.length, 0);
});

test("an unreachable siteverify fails closed", async () => {
  enableTurnstile();
  setTurnstileVerifier(async () => ({ success: false, errorCodes: ["siteverify-unreachable"] }));
  const res = await call("/guest/verify", { token: GOOD_TOKEN }, { ip: newIp() });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body.error_codes, ["siteverify-unreachable"]);
});

test("upload (image OCR costs Groq money) requires a verified device", async () => {
  enableTurnstile();
  const ip = newIp();
  const blocked = await api.fetch(
    new Request("http://local/upload", { method: "POST", headers: { "x-real-ip": ip }, body: new FormData() })
  );
  assert.equal(blocked.status, 401);
  assert.equal((await blocked.json()).code, "GUEST_VERIFICATION_REQUIRED");

  const device = await verifiedDevice(ip);
  const allowed = await api.fetch(
    new Request("http://local/upload", {
      method: "POST",
      headers: { "x-real-ip": ip, cookie: `device_id=${device}` },
      body: new FormData(),
    })
  );
  assert.notEqual(allowed.status, 401, "a verified guest reaches the upload handler");
});

// ---------------------------------------------------------------------------
// Per-IP daily caps
// ---------------------------------------------------------------------------

test("verifications per IP are capped, other IPs are unaffected", async () => {
  enableTurnstile();
  config.guestIpDailyVerifications = 2;
  const ip = newIp();
  await verifiedDevice(ip);
  await verifiedDevice(ip);

  const third = await call("/guest/verify", { token: GOOD_TOKEN }, { ip });
  assert.equal(third.status, 429);
  assert.equal(third.body.code, "GUEST_IP_LIMIT");
  assert.equal(third.body.requiresAuth, true);
  assert.equal(verifierCalls.length, 2, "a capped IP must not spend siteverify calls");

  await verifiedDevice(newIp());
});

test("failed verifications do not use up the IP's allowance", async () => {
  enableTurnstile();
  config.guestIpDailyVerifications = 1;
  const ip = newIp();
  assert.equal((await call("/guest/verify", { token: "forged" }, { ip })).status, 403);
  await verifiedDevice(ip);
});

test("guest requests per IP are capped across devices", async () => {
  enableTurnstile();
  config.guestIpDailyRequests = 3;
  const ip = newIp();
  const deviceA = await verifiedDevice(ip);
  const deviceB = await verifiedDevice(ip);

  assert.equal((await explain({ ip, device: deviceA })).status, 200);
  assert.equal((await explain({ ip, device: deviceA })).status, 200);
  assert.equal((await explain({ ip, device: deviceB })).status, 200);

  const capped = await explain({ ip, device: deviceB });
  assert.equal(capped.status, 401);
  assert.equal(capped.body.code, "GUEST_IP_LIMIT");
  assert.equal(capped.body.requiresAuth, true);
  assert.equal(fake.calls.length, 3);
});

test("the request cap also applies when Turnstile is disabled", async () => {
  config.guestIpDailyRequests = 2;
  const ip = newIp();
  // No cookie: every request is a "new device", the bypass the IP cap closes
  assert.equal((await explain({ ip })).status, 200);
  assert.equal((await explain({ ip })).status, 200);
  const capped = await explain({ ip });
  assert.equal(capped.status, 401);
  assert.equal(capped.body.code, "GUEST_IP_LIMIT");
});

test("the per-device limit of 5 still applies inside the IP allowance", async () => {
  enableTurnstile();
  const ip = newIp();
  const device = await verifiedDevice(ip);
  for (let i = 0; i < 5; i++) assert.equal((await explain({ ip, device })).status, 200);
  const sixth = await explain({ ip, device });
  assert.equal(sixth.status, 401);
  assert.equal(sixth.body.code, "GUEST_LIMIT_EXCEEDED");
});

// ---------------------------------------------------------------------------
// Trusted client IP
// ---------------------------------------------------------------------------

test("a spoofed X-Forwarded-For does not change the client IP behind X-Real-IP", async () => {
  config.guestIpDailyRequests = 2;
  const ip = newIp();
  for (const spoof of ["1.1.1.1", "8.8.8.8"]) {
    const res = await explain({ ip, headers: { "x-forwarded-for": `${spoof}, ${ip}` } });
    assert.equal(res.status, 200);
  }
  const capped = await explain({ ip, headers: { "x-forwarded-for": "9.9.9.9" } });
  assert.equal(capped.status, 401);
  assert.equal(capped.body.code, "GUEST_IP_LIMIT");
});

function fakeContext(headers: Record<string, string>, socketIp?: string): any {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    req: { header: (name: string) => lower[name.toLowerCase()] },
    env: socketIp ? { incoming: { socket: { remoteAddress: socketIp } } } : undefined,
  };
}

// Runs before any other test sends CF-Connecting-IP (the warning is once per process)
test("traffic through Cloudflare without CLIENT_IP_HEADER=cf-connecting-ip logs one warning", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  config.clientIpHeader = "x-real-ip";
  getClientIp(fakeContext({ "x-real-ip": "172.70.1.1", "cf-connecting-ip": "198.51.100.10" }));
  getClientIp(fakeContext({ "x-real-ip": "172.70.1.2", "cf-connecting-ip": "198.51.100.11" }));
  const calls = warn.mock.calls.filter((call) => String(call.arguments[0]).includes("CF-Connecting-IP"));
  assert.equal(calls.length, 1);
});

test("getClientIp honours CLIENT_IP_HEADER", () => {
  const headers = {
    "x-real-ip": "198.51.100.7",
    "cf-connecting-ip": "198.51.100.8",
    "x-forwarded-for": "6.6.6.6, 198.51.100.9",
  };

  config.clientIpHeader = "x-real-ip";
  assert.equal(getClientIp(fakeContext(headers, "10.0.0.1")), "198.51.100.7");

  config.clientIpHeader = "cf-connecting-ip";
  assert.equal(getClientIp(fakeContext(headers, "10.0.0.1")), "198.51.100.8");

  // Rightmost entry: the one appended by our own proxy, not the client-supplied first one
  config.clientIpHeader = "x-forwarded-for";
  assert.equal(getClientIp(fakeContext(headers, "10.0.0.1")), "198.51.100.9");

  config.clientIpHeader = "none";
  assert.equal(getClientIp(fakeContext(headers, "10.0.0.1")), "10.0.0.1");

  // Missing header falls back to the socket, then to "unknown"
  config.clientIpHeader = "x-real-ip";
  assert.equal(getClientIp(fakeContext({}, "10.0.0.2")), "10.0.0.2");
  assert.equal(getClientIp(fakeContext({})), "unknown");
});

test("expired IP windows are cleaned up", () => {
  const ip = newIp();
  guestIpLimiter.recordRequest(ip);
  assert.equal(guestIpLimiter.cleanup(), 0, "a live window is kept");

  const counters = (guestIpLimiter as any).counters as Map<string, { windowStart: number }>;
  counters.get(ip)!.windowStart -= 24 * 60 * 60 * 1000;
  assert.equal(guestIpLimiter.cleanup(), 1);
  assert.equal(guestIpLimiter.canRequest(ip), true);
});
