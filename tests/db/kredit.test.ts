/**
 * Kredit plans and metering against a real Postgres database.
 *
 *   TEST_DATABASE_URL=postgresql://user@localhost:5432/ilmatrix_test npm run test:db
 *
 * Point it at a disposable database: it is migrated and receives test rows.
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = DB_URL ? false : "TEST_DATABASE_URL not set";

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  process.env.DATABASE_SSL ??= "false";
}

let api: any;
let query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number }>;
let kreditService: typeof import("../../src/services/kreditService.js");
let stopBackgroundTasks: () => void;
let closeDatabase: () => Promise<void>;
let fakeCalls: any[] = [];

// Every fake completion uses 1,000 prompt + 500 completion tokens:
// on gpt-oss-120b that is (1000*0.15 + 500*0.6)/1e6 USD * 4500 = 2.03 kredit
const CHARGE = 2.03;
/** Streamed answers from the fake Groq (tests change these). */
const stream = { pieces: ["Jawa", "ban."], delayMs: 0 };
const createdUsers: string[] = [];

before(async () => {
  if (skip) return;
  const migrations = await import("../../src/services/migrationService.js");
  await migrations.runMigrations();
  ({ query, closeDatabase } = await import("../../src/services/databaseService.js"));
  kreditService = await import("../../src/services/kreditService.js");
  const routes = await import("../../src/routes.js");
  api = routes.default;
  stopBackgroundTasks = routes.stopBackgroundTasks;

  const { groqService } = await import("../../src/services/groqService.js");
  const { GroqProvider } = await import("../../src/services/groqProvider.js");
  const { createFakeGroq, completion, streamOf, TEST_PROVIDER_CONFIG } = await import("../ai/fakeGroq.js");
  const fake = createFakeGroq((params, _i, options) =>
    params.stream
      ? streamOf(stream.pieces, { usage: { prompt: 1000, completion: 500 }, delayMs: stream.delayMs, signal: options?.signal })
      : completion(params.model.startsWith("qwen") ? "TEKS PANJANG DARI GAMBAR ".repeat(5) : "Jawaban.", { prompt: 1000, completion: 500 })
  );
  fakeCalls = fake.calls;
  (groqService as any).provider = new GroqProvider({ client: fake.client, config: TEST_PROVIDER_CONFIG });
});

beforeEach(() => {
  if (!skip) fakeCalls.length = 0;
});

after(async () => {
  if (skip) return;
  await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUsers]);
  stopBackgroundTasks();
  await closeDatabase();
  setTimeout(() => process.exit(0), 100).unref();
});

async function createUser(opts: { admin?: boolean; name?: string } = {}) {
  const { rows } = await query(
    `INSERT INTO users (email, name, is_admin) VALUES ($1, $2, $3) RETURNING id`,
    [`kredit-${randomUUID()}@example.com`, opts.name ?? "Siswa", !!opts.admin]
  );
  const token = randomBytes(32).toString("hex");
  await query(
    `INSERT INTO user_sessions (user_id, session_token, expires_at)
       VALUES ($1, encode(sha256(convert_to($2, 'UTF8')), 'hex'), NOW() + INTERVAL '1 day')`,
    [rows[0].id, token]
  );
  createdUsers.push(rows[0].id);
  return { id: rows[0].id as string, cookie: `session=${token}` };
}

async function request(method: string, path: string, opts: { cookie?: string; json?: unknown; form?: FormData } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    body = opts.form;
  }
  const res = await api.fetch(new Request(`http://local${path}`, { method, headers, body }));
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { __raw: text };
  }
  return { status: res.status, body: data, headers: res.headers };
}

let n = 0;
const explain = (cookie: string) =>
  request("POST", "/explain", { cookie, json: { materialText: `Materi ${++n}: fotosintesis di kloroplas.` } });

async function userRow(id: string) {
  const { rows } = await query(
    `SELECT weekly_kredit_used::float AS weekly, monthly_kredit_used::float AS monthly,
            weekly_tokens_used AS tokens, weekly_usage_reset_at, plan, plan_expires_at
     FROM users WHERE id = $1`,
    [id]
  );
  return rows[0];
}

test("a new user starts on the free plan with 150 kredit a week", { skip }, async () => {
  const u = await createUser();
  const res = await request("GET", "/usage/stats", { cookie: u.cookie });
  assert.equal(res.status, 200);
  assert.equal(res.body.usage.unit, "kredit");
  assert.equal(res.body.usage.plan.code, "free");
  assert.equal(res.body.usage.weekly.limit, 150);
  assert.equal(res.body.usage.total_remaining, 150);
});

test("AI requests are charged in kredit and logged (quota check no longer fails open)", { skip }, async () => {
  const u = await createUser();
  const res = await explain(u.cookie);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers.get("x-kredit-used"), CHARGE.toFixed(2));

  const row = await userRow(u.id);
  assert.equal(row.weekly, CHARGE);
  assert.equal(row.monthly, CHARGE);
  assert.equal(row.tokens, 1500);

  const log = await query(`SELECT kredit_used::float AS kredit, tokens_used, model_used FROM token_usage_logs WHERE user_id = $1`, [u.id]);
  assert.deepEqual(log.rows, [{ kredit: CHARGE, tokens_used: 1500, model_used: "openai/gpt-oss-120b" }]);
});

test("without kredit the request is blocked with a friendly message", { skip }, async () => {
  const u = await createUser();
  await query(`UPDATE users SET weekly_kredit_used = 150 WHERE id = $1`, [u.id]);
  const res = await explain(u.cookie);
  assert.equal(res.status, 429);
  assert.equal(res.body.code, "KREDIT_EXHAUSTED");
  assert.match(res.body.answer, /Kredit belajarmu sudah habis.*WIB/);
  assert.equal(fakeCalls.length, 0, "Groq is not called");
});

test("the last request may overshoot, then the user is blocked", { skip }, async () => {
  const u = await createUser();
  await query(`UPDATE users SET weekly_kredit_used = 149 WHERE id = $1`, [u.id]);
  assert.equal((await explain(u.cookie)).status, 200);
  assert.equal((await userRow(u.id)).weekly, 149 + CHARGE);
  assert.equal((await explain(u.cookie)).status, 429);
});

test("the weekly allowance resets on Monday 00:00 UTC", { skip }, async () => {
  const u = await createUser();
  await query(
    `UPDATE users SET weekly_kredit_used = 150, weekly_tokens_used = 99999, weekly_usage_reset_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
    [u.id]
  );
  assert.equal((await explain(u.cookie)).status, 200);
  const row = await userRow(u.id);
  assert.equal(row.weekly, CHARGE);
  assert.equal(row.tokens, 1500);
  const reset = new Date(row.weekly_usage_reset_at);
  assert.ok(reset > new Date());
  assert.equal(reset.getUTCDay(), 1, "next Monday");
  assert.equal(reset.getUTCHours(), 0);
});

test("passes are used after the weekly allowance, soonest-expiring first", { skip }, async () => {
  const u = await createUser();
  await query(`UPDATE users SET weekly_kredit_used = 150 WHERE id = $1`, [u.id]);
  await kreditService.grantProduct(u.id, "topup", "test-topup"); // 90 days
  await kreditService.grantProduct(u.id, "pass_7d", "test-pass"); // 7 days, used first

  const res = await explain(u.cookie);
  assert.equal(res.status, 200);
  const grants = await query(
    `SELECT source, kredit_used::float AS used FROM kredit_grants WHERE user_id = $1 ORDER BY expires_at`,
    [u.id]
  );
  assert.deepEqual(grants.rows, [
    { source: "pass_7d", used: CHARGE },
    { source: "topup", used: 0 },
  ]);
  assert.equal((await userRow(u.id)).weekly, 150, "weekly counter unchanged");

  const stats = await request("GET", "/usage/stats", { cookie: u.cookie });
  assert.equal(stats.body.usage.extra.remaining, 1600 - CHARGE);
});

test("a charge spanning the allowance and a pass splits correctly", { skip }, async () => {
  const u = await createUser();
  await query(`UPDATE users SET weekly_kredit_used = 149 WHERE id = $1`, [u.id]);
  await kreditService.grantKredit(u.id, { source: "admin", kredit: 10, validDays: null });
  await kreditService.chargeKredit(u.id, 3);
  assert.equal((await userRow(u.id)).weekly, 150);
  const g = await query(`SELECT kredit_used::float AS used FROM kredit_grants WHERE user_id = $1`, [u.id]);
  assert.equal(g.rows[0].used, 2);
});

test("expired passes do not count", { skip }, async () => {
  const u = await createUser();
  await query(`UPDATE users SET weekly_kredit_used = 150 WHERE id = $1`, [u.id]);
  await query(
    `INSERT INTO kredit_grants (user_id, source, kredit_total, expires_at) VALUES ($1, 'pass_7d', 1000, NOW() - INTERVAL '1 hour')`,
    [u.id]
  );
  assert.equal((await explain(u.cookie)).status, 429);
});

test("paid plans raise the allowance, extend on renewal, and fall back to free when expired", { skip }, async () => {
  const u = await createUser();
  await kreditService.setPlan(u.id, "semester");
  let status = await kreditService.getKreditStatus(u.id);
  assert.equal(status.plan, "semester");
  assert.equal(status.weeklyLimit, 700);

  await kreditService.setPlan(u.id, "bulanan");
  await kreditService.setPlan(u.id, "bulanan");
  const days = (new Date((await userRow(u.id)).plan_expires_at).getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 59.9 && days < 60.1, `renewal extends the active period (${days} days)`);

  await query(`UPDATE users SET plan_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [u.id]);
  status = await kreditService.getKreditStatus(u.id);
  assert.equal(status.plan, "free");
  assert.equal(status.weeklyLimit, 150);
});

test("admins are metered but never blocked; disabled accounts are blocked", { skip }, async () => {
  const admin = await createUser({ admin: true });
  await query(`UPDATE users SET weekly_kredit_used = 10000 WHERE id = $1`, [admin.id]);
  assert.equal((await explain(admin.cookie)).status, 200);
  assert.equal((await userRow(admin.id)).weekly, 10000 + CHARGE);

  const u = await createUser();
  await query(`UPDATE users SET token_access_enabled = FALSE WHERE id = $1`, [u.id]);
  const res = await explain(u.cookie);
  assert.equal(res.status, 429);
  assert.equal(res.body.code, "AI_ACCESS_DISABLED");
});

test("image OCR on upload is charged, and skipped when kredit has run out", { skip }, async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAAAAABWESUoAAAAKklEQVR42mP4TwAwjCgFDHAA4SGRRCtApoeIAiQfkalgqIYDpdE93PMFAN9jVNYpxnfhAAAAAElFTkSuQmCC",
    "base64"
  );
  const uploadImage = (cookie: string) => {
    const form = new FormData();
    form.append("file", new File([png], "papan.png", { type: "image/png" }));
    return request("POST", "/upload", { cookie, form });
  };

  const u = await createUser();
  const ok = await uploadImage(u.cookie);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(fakeCalls.length, 1);
  assert.equal(fakeCalls[0].params.model, "qwen/qwen3.8-27b");
  // (1000*0.8 + 500*4)/1e6 USD * 4500 = 12.6 kredit
  assert.equal((await userRow(u.id)).weekly, 12.6);

  await query(`UPDATE users SET weekly_kredit_used = 150 WHERE id = $1`, [u.id]);
  fakeCalls.length = 0;
  const skipped = await uploadImage(u.cookie);
  assert.equal(skipped.status, 200, "upload still succeeds");
  assert.equal(fakeCalls.length, 0, "no vision call without kredit");
  assert.equal((await userRow(u.id)).weekly, 150);
});

test("admins can set plans and grant kredit; other users cannot", { skip }, async () => {
  const admin = await createUser({ admin: true });
  const u = await createUser();

  const forbidden = await request("POST", `/admin/usage/user/${u.id}/set-plan`, { cookie: u.cookie, json: { plan: "semester" } });
  assert.equal(forbidden.status, 403);

  const plan = await request("POST", `/admin/usage/user/${u.id}/set-plan`, { cookie: admin.cookie, json: { plan: "semester" } });
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.equal(plan.body.usage.plan.code, "semester");
  assert.equal(plan.body.usage.weekly.limit, 700);

  const bad = await request("POST", `/admin/usage/user/${u.id}/set-plan`, { cookie: admin.cookie, json: { plan: "gold" } });
  assert.equal(bad.status, 400);

  const pass = await request("POST", `/admin/usage/user/${u.id}/grant-kredit`, {
    cookie: admin.cookie,
    json: { product: "pass_7d", reference: "QRIS-123" },
  });
  assert.equal(pass.status, 200);
  assert.equal(pass.body.usage.extra.remaining, 1000);

  const custom = await request("POST", `/admin/usage/user/${u.id}/grant-kredit`, {
    cookie: admin.cookie,
    json: { kredit: 50, valid_days: 30 },
  });
  assert.equal(custom.body.usage.extra.remaining, 1050);

  const override = await request("POST", `/admin/usage/user/${u.id}/update-limits`, { cookie: admin.cookie, json: { weekly_limit: 25 } });
  assert.equal(override.status, 200);
  assert.equal((await kreditService.getKreditStatus(u.id)).weeklyLimit, 25);
});

test("admin dashboard and CSV export report kredit, with safe CSV quoting", { skip }, async () => {
  const admin = await createUser({ admin: true });
  const u = await createUser({ name: '=HYPERLINK("http://evil"), "Budi"' });
  await kreditService.chargeKredit(u.id, 12.5, 4000);

  const dash = await request("GET", "/admin/usage/dashboard?limit=500", { cookie: admin.cookie });
  assert.equal(dash.status, 200);
  const row = dash.body.users.find((x: any) => x.user_id === u.id);
  assert.equal(row.weekly_kredit_used, 12.5);
  assert.equal(row.weekly_kredit_limit, 150);
  assert.equal(row.plan, "free");
  assert.ok(typeof dash.body.aggregate.total_kredit_used_weekly === "number");

  const csv = await request("GET", "/admin/usage/export", { cookie: admin.cookie });
  const line = String(csv.body.__raw).split("\n").find((l) => l.includes(u.id))!;
  assert.ok(line.includes(`"'=HYPERLINK(""http://evil""), ""Budi"""`), line);
});

test("the AI rate limit counts per account: a new device cookie does not reset it", { skip }, async () => {
  const config = (await import("../../src/config/env.js")).default;
  const { aiRateLimiter } = await import("../../src/middleware/aiRateLimit.js");
  const saved = config.aiRateLimitPerMinute;
  config.aiRateLimitPerMinute = 2;
  try {
    const u = await createUser();
    const withDevice = () => `${u.cookie}; device_id=${randomUUID()}`;
    assert.equal((await explain(withDevice())).status, 200);
    assert.equal((await explain(withDevice())).status, 200);

    const limited = await explain(withDevice());
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, "AI_RATE_LIMITED");
    assert.equal((await userRow(u.id)).weekly, Number((2 * CHARGE).toFixed(2)), "the rejected request is not charged");

    // Same IP, different account: unaffected
    const other = await createUser();
    assert.equal((await explain(other.cookie)).status, 200);
  } finally {
    config.aiRateLimitPerMinute = saved;
    aiRateLimiter.reset();
  }
});

test("a streamed answer is charged from the usage Groq reports at the end", { skip }, async () => {
  stream.pieces = ["Jawa", "ban."];
  stream.delayMs = 0;
  const u = await createUser();
  const res = await api.fetch(
    new Request("http://local/explain", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: u.cookie },
      body: JSON.stringify({ materialText: `Materi ${++n}: fotosintesis.`, stream: true }),
    })
  );
  const text = await res.text();
  assert.match(text, /event: done/);
  assert.match(text, /"total_tokens":1500/);
  assert.equal((await userRow(u.id)).weekly, CHARGE);
  const log = await query(`SELECT kredit_used::float AS kredit, metadata FROM token_usage_logs WHERE user_id = $1`, [u.id]);
  assert.equal(log.rows[0].kredit, CHARGE);
  assert.equal(log.rows[0].metadata.streamed, true);
});

test("leaving a stream early is charged an estimate of what was used", { skip }, async () => {
  stream.pieces = Array.from({ length: 60 }, (_, i) => `kata${i} `);
  stream.delayMs = 20;
  const u = await createUser();
  const res = await api.fetch(
    new Request("http://local/explain", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: u.cookie },
      body: JSON.stringify({ materialText: `Materi ${++n}: fotosintesis.`, stream: true }),
    })
  );
  const reader = res.body!.getReader();
  let seen = "";
  while (!/event: delta/.test(seen)) seen += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();

  let row: any;
  for (let i = 0; i < 100; i++) {
    row = await userRow(u.id);
    if (row.weekly > 0) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(row.weekly > 0 && row.weekly < CHARGE, `estimated charge expected, got ${row.weekly}`);
  const log = await query(`SELECT metadata FROM token_usage_logs WHERE user_id = $1`, [u.id]);
  assert.equal(log.rows[0].metadata.aborted, true);
  assert.equal(log.rows[0].metadata.estimated, true);
  stream.pieces = ["Jawa", "ban."];
  stream.delayMs = 0;
});
