/**
 * Daily/weekly AI quotas against a real Postgres database.
 *
 *   TEST_DATABASE_URL=postgresql://user@localhost:5432/ilmatrix_test npm run test:db
 *
 * Point it at a disposable database: it is migrated and receives test rows.
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = DB_URL ? false : "TEST_DATABASE_URL not set";

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  process.env.DATABASE_SSL ??= "false";
}

let api: any;
let query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number }>;
let quota: typeof import("../../src/services/quotaService.js");
let kreditService: typeof import("../../src/services/kreditService.js");
let reservationKredit: typeof import("../../src/services/quotaEstimates.js").reservationKredit;
let config: typeof import("../../src/config/env.js").default;
let STUDY_TOPICS: any[];
let stopBackgroundTasks: () => void;
let closeDatabase: () => Promise<void>;
let fakeCalls: any[] = [];

// Every fake completion uses 1,000 prompt + 500 completion tokens:
// on gpt-oss-120b that is (1000*0.15 + 500*0.6)/1e6 USD * 4500 = 2.03 kredit
const CHARGE = 2.03;
/** Fake model behaviour (tests change these). */
const fake = { delayMs: 0, fail: false };
/** Streamed answers from the fake model. */
const stream = { pieces: ["Jawa", "ban."], delayMs: 0 };
const createdUsers: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Database fault injection for listed users only (other suites share the
 * database): settlements fail the first N times (a sequence, so the count
 * survives the rolled-back transactions), usage-log inserts always fail.
 */
const FAULTS_SQL = `
  CREATE SEQUENCE IF NOT EXISTS test_settle_failures;
  CREATE TABLE IF NOT EXISTS test_fail_settle (user_id UUID PRIMARY KEY, failures INT NOT NULL);
  CREATE TABLE IF NOT EXISTS test_fail_log (user_id UUID PRIMARY KEY);
  CREATE OR REPLACE FUNCTION test_fail_settlement() RETURNS trigger AS $$
  DECLARE wanted INT;
  BEGIN
    SELECT failures INTO wanted FROM test_fail_settle WHERE user_id = NEW.user_id;
    IF wanted IS NOT NULL THEN
      IF nextval('test_settle_failures') <= wanted THEN
        RAISE EXCEPTION 'injected settlement failure';
      END IF;
    END IF;
    RETURN NEW;
  END $$ LANGUAGE plpgsql;
  CREATE OR REPLACE FUNCTION test_fail_log() RETURNS trigger AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM test_fail_log WHERE user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'injected log failure';
    END IF;
    RETURN NEW;
  END $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS test_fail_settlement ON ai_quota_reservations;
  CREATE TRIGGER test_fail_settlement BEFORE UPDATE ON ai_quota_reservations
    FOR EACH ROW WHEN (NEW.status IN ('settled', 'released')) EXECUTE FUNCTION test_fail_settlement();
  DROP TRIGGER IF EXISTS test_fail_log ON token_usage_logs;
  CREATE TRIGGER test_fail_log BEFORE INSERT ON token_usage_logs FOR EACH ROW EXECUTE FUNCTION test_fail_log();`;

/** Make the next `times` settlements of this user's reservations fail. */
async function failSettlements(userId: string, times: number) {
  await query(`DELETE FROM test_fail_settle`);
  await query(`ALTER SEQUENCE test_settle_failures RESTART`);
  await query(`INSERT INTO test_fail_settle (user_id, failures) VALUES ($1, $2)`, [userId, times]);
}

before(async () => {
  if (skip) return;
  const migrations = await import("../../src/services/migrationService.js");
  await migrations.runMigrations();
  ({ query, closeDatabase } = await import("../../src/services/databaseService.js"));
  quota = await import("../../src/services/quotaService.js");
  kreditService = await import("../../src/services/kreditService.js");
  ({ reservationKredit } = await import("../../src/services/quotaEstimates.js"));
  config = (await import("../../src/config/env.js")).default;
  const routes = await import("../../src/routes.js");
  api = routes.default;
  stopBackgroundTasks = routes.stopBackgroundTasks;
  await query(`UPDATE ai_quota_settings SET daily_kredit_limit = NULL, weekly_kredit_limit = NULL`);
  await query(FAULTS_SQL);

  const { groqService } = await import("../../src/services/groqService.js");
  const { GroqProvider } = await import("../../src/services/groqProvider.js");
  const fakeGroq = await import("../ai/fakeGroq.js");
  STUDY_TOPICS = fakeGroq.STUDY_TOPICS;
  const usage = { prompt: 1000, completion: 500 };
  const client = fakeGroq.createFakeGroq(async (params, _i, options) => {
    if (fake.fail) throw fakeGroq.apiError(503, "upstream connect error");
    if (params.stream) {
      return fakeGroq.streamOf(stream.pieces, { usage, delayMs: stream.delayMs, signal: options?.signal });
    }
    if (fake.delayMs) await sleep(fake.delayMs);
    const schema = params.response_format?.json_schema?.name;
    if (schema) return fakeGroq.completion(JSON.stringify(fakeGroq.STUDY_JSON_RESPONSES[schema]), usage);
    if (params.model.startsWith("qwen")) return fakeGroq.completion("TEKS PANJANG DARI GAMBAR ".repeat(5), usage);
    return fakeGroq.completion("Jawaban.", usage);
  });
  fakeCalls = client.calls;
  (groqService as any).provider = new GroqProvider({ client: client.client, config: fakeGroq.TEST_PROVIDER_CONFIG });
});

beforeEach(() => {
  if (skip) return;
  fakeCalls.length = 0;
  fake.delayMs = 0;
  fake.fail = false;
});

after(async () => {
  if (skip) return;
  await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUsers]);
  await query(`UPDATE ai_quota_settings SET daily_kredit_limit = NULL, weekly_kredit_limit = NULL, updated_by = NULL`);
  await query(`
    DROP TRIGGER IF EXISTS test_fail_settlement ON ai_quota_reservations;
    DROP TRIGGER IF EXISTS test_fail_log ON token_usage_logs;
    DROP FUNCTION IF EXISTS test_fail_settlement();
    DROP FUNCTION IF EXISTS test_fail_log();
    DROP TABLE IF EXISTS test_fail_settle, test_fail_log;
    DROP SEQUENCE IF EXISTS test_settle_failures;`);
  stopBackgroundTasks();
  await closeDatabase();
  setTimeout(() => process.exit(0), 100).unref();
});

async function createUser(opts: { admin?: boolean; name?: string; daily?: number; weekly?: number } = {}) {
  const { rows } = await query(
    `INSERT INTO users (email, name, is_admin, daily_kredit_override, weekly_kredit_override) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [`quota-${randomUUID()}@example.com`, opts.name ?? "Siswa", !!opts.admin, opts.daily ?? null, opts.weekly ?? null]
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
const material = () => `Materi ${++n}: fotosintesis di kloroplas.`;
const explain = (cookie: string) => request("POST", "/explain", { cookie, json: { materialText: material() } });

/** Kredit used in the current quota day and week. */
async function usage(id: string) {
  const p = await quota.periodsAt(new Date());
  const { rows } = await query(
    `SELECT period_type, kredit_used::float AS kredit FROM ai_quota_usage
     WHERE user_id = $1 AND ((period_type = 'day' AND period_start = $2) OR (period_type = 'week' AND period_start = $3))`,
    [id, p.dayStart, p.weekStart]
  );
  const out = { day: 0, week: 0 };
  for (const r of rows) out[r.period_type as "day" | "week"] = r.kredit;
  return out;
}

/** Set the current day's and week's usage. */
async function setUsage(id: string, day: number, week: number, at = new Date()) {
  const p = await quota.periodsAt(at);
  await query(
    `INSERT INTO ai_quota_usage (user_id, period_type, period_start, kredit_used) VALUES ($1, 'day', $2, $3), ($1, 'week', $4, $5)
     ON CONFLICT (user_id, period_type, period_start) DO UPDATE SET kredit_used = EXCLUDED.kredit_used`,
    [id, p.dayStart, day, p.weekStart, week]
  );
}

const reservations = async (id: string) =>
  (await query(`SELECT status, funded_by, reserved_kredit::float AS reserved, charged_kredit::float AS charged FROM ai_quota_reservations WHERE user_id = $1 ORDER BY created_at`, [id])).rows;

// Sunday 22 November 2026 23:59:59 WIB, and the next second: Monday 00:00 WIB (Sunday 17:00 UTC)
const SUNDAY_LATE = new Date("2026-11-22T16:59:59Z");
const MONDAY_START = new Date("2026-11-22T17:00:00Z");

// ---------------------------------------------------------------------------
// Quotas
// ---------------------------------------------------------------------------

test("a new user gets the default daily and weekly quotas, with no plan or extra kredit while payments are off", { skip }, async () => {
  const u = await createUser();
  const res = await request("GET", "/usage/stats", { cookie: u.cookie });
  assert.equal(res.status, 200);
  const q = res.body.usage;
  assert.equal(q.unit, "kredit");
  assert.equal(q.timezone, "Asia/Jakarta");
  assert.equal(q.daily.limit, config.aiDailyKreditLimit);
  assert.equal(q.weekly.limit, config.aiWeeklyKreditLimit);
  assert.equal(q.daily.remaining, config.aiDailyKreditLimit);
  assert.equal(q.daily.limit_source, "env");
  assert.equal(q.payments, undefined);
  assert.equal(res.body.payments_enabled, false);
  assert.deepEqual(res.body.recent_days, []);
  assert.equal(res.body.tool_estimates.explain, reservationKredit("explain"));
});

test("every AI request counts against both quotas, is logged, and settles its reservation", { skip }, async () => {
  const u = await createUser();
  const res = await explain(u.cookie);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers.get("x-kredit-used"), CHARGE.toFixed(2));
  assert.equal(res.headers.get("x-quota-daily-remaining"), (config.aiDailyKreditLimit - CHARGE).toFixed(2));

  assert.deepEqual(await usage(u.id), { day: CHARGE, week: CHARGE });
  assert.deepEqual(await reservations(u.id), [{ status: "settled", funded_by: "quota", reserved: reservationKredit("explain"), charged: CHARGE }]);
  const log = await query(`SELECT kredit_used::float AS kredit, tokens_used, model_used FROM token_usage_logs WHERE user_id = $1`, [u.id]);
  assert.deepEqual(log.rows, [{ kredit: CHARGE, tokens_used: 1500, model_used: "openai/gpt-oss-120b" }]);

  const stats = await request("GET", "/usage/stats", { cookie: u.cookie });
  assert.equal(stats.body.recent_days.length, 1);
  assert.deepEqual({ kredit: stats.body.recent_days[0].kredit, requests: stats.body.recent_days[0].requests }, { kredit: CHARGE, requests: 1 });
});

test("a request is refused when the daily quota is used up, with when it resets", { skip }, async () => {
  const u = await createUser();
  await setUsage(u.id, config.aiDailyKreditLimit, config.aiDailyKreditLimit);
  const res = await explain(u.cookie);
  assert.equal(res.status, 429);
  assert.equal(res.body.code, "QUOTA_EXCEEDED");
  assert.equal(res.body.limit, "daily");
  assert.deepEqual(res.body.exhausted, ["daily"]);
  assert.equal(new Date(res.body.resets_at).getTime(), (await quota.periodsAt(new Date())).dayResetsAt.getTime());
  assert.match(res.body.answer, /harian.*WIB/);
  assert.equal(res.body.upgrade_url, undefined, "no buy link while payments are off");
  assert.equal(fakeCalls.length, 0, "the model is not called");
  assert.deepEqual(await reservations(u.id), [], "nothing is held for a refused request");
});

test("a request is refused when the weekly quota is used up, even with room today", { skip }, async () => {
  const u = await createUser();
  await setUsage(u.id, 0, config.aiWeeklyKreditLimit);
  const res = await explain(u.cookie);
  assert.equal(res.status, 429);
  assert.equal(res.body.limit, "weekly");
  assert.deepEqual(res.body.exhausted, ["weekly"]);
  assert.match(res.body.answer, /mingguan/);
});

test("admission needs room for the request's reservation, not just any kredit left", { skip }, async () => {
  const u = await createUser();
  const need = reservationKredit("explain");
  await setUsage(u.id, round2(config.aiDailyKreditLimit - need + 1), round2(config.aiDailyKreditLimit - need + 1));
  const res = await explain(u.cookie);
  assert.equal(res.status, 429);
  assert.equal(res.body.required, need);
  assert.match(res.body.answer, /belum cukup untuk permintaan ini/);
  assert.equal(fakeCalls.length, 0);
});

test("days reset at 00:00 WIB and weeks on Monday 00:00 WIB (not UTC)", { skip }, async () => {
  const late = await quota.periodsAt(SUNDAY_LATE);
  assert.deepEqual([late.dayStart, late.weekStart], ["2026-11-22", "2026-11-16"]);
  assert.equal(late.dayResetsAt.toISOString(), "2026-11-22T17:00:00.000Z");
  assert.equal(late.weekResetsAt.toISOString(), "2026-11-22T17:00:00.000Z");

  const start = await quota.periodsAt(MONDAY_START);
  assert.deepEqual([start.dayStart, start.weekStart], ["2026-11-23", "2026-11-23"]);
  assert.equal(start.dayResetsAt.toISOString(), "2026-11-23T17:00:00.000Z");
  assert.equal(start.weekResetsAt.toISOString(), "2026-11-29T17:00:00.000Z", "next Monday 00:00 WIB");

  // 03:00 WIB on Monday is still Sunday in UTC: the week has already changed
  assert.equal((await quota.periodsAt(new Date("2026-11-22T20:00:00Z"))).weekStart, "2026-11-23");

  // A user who used everything on Sunday evening can use AI again from Monday 00:00 WIB
  const u = await createUser();
  await setUsage(u.id, config.aiDailyKreditLimit, config.aiWeeklyKreditLimit, SUNDAY_LATE);
  const refused = await quota.reserve(u.id, "explain", 5, SUNDAY_LATE);
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.reason === "quota" && refused.period, "weekly");
  const admitted = await quota.reserve(u.id, "explain", 5, MONDAY_START);
  assert.equal(admitted.ok, true);
  assert.ok(admitted.ok && admitted.status.daily.remaining === config.aiDailyKreditLimit - 5);
});

test("a request that ends after midnight is charged to the day and week it started in", { skip }, async () => {
  const u = await createUser();
  const r = await quota.reserve(u.id, "explain", 10, new Date("2026-11-22T16:59:50Z"));
  assert.ok(r.ok);
  await quota.finish(r.reservationId, 4, new Date("2026-11-22T17:00:10Z"));
  const rows = (await query(
    `SELECT period_type, period_start::text, kredit_used::float AS kredit FROM ai_quota_usage WHERE user_id = $1 ORDER BY period_type`,
    [u.id]
  )).rows;
  assert.deepEqual(rows, [
    { period_type: "day", period_start: "2026-11-22", kredit: 4 },
    { period_type: "week", period_start: "2026-11-16", kredit: 4 },
  ]);
  const monday = await quota.reserve(u.id, "explain", 10, new Date("2026-11-22T17:00:20Z"));
  assert.ok(monday.ok && monday.status.daily.used === 0 && monday.status.weekly.used === 0, "the new day and week start empty");
});

test("parallel requests can't get past the quota together (atomic reservations)", { skip }, async () => {
  const need = reservationKredit("explain");
  const u = await createUser({ daily: round2(need * 1.5) });
  const results = await Promise.all(Array.from({ length: 10 }, () => quota.reserve(u.id, "explain", need)));
  assert.equal(results.filter((r) => r.ok).length, 1, "only one reservation fits");

  // The same through the API, with the requests overlapping in the model
  const v = await createUser({ daily: round2(need * 1.5) });
  const savedConcurrent = config.aiMaxConcurrent;
  const savedPerMinute = config.aiRateLimitPerMinute;
  config.aiMaxConcurrent = 20;
  config.aiRateLimitPerMinute = 1000;
  fake.delayMs = 300;
  try {
    const responses = await Promise.all(Array.from({ length: 5 }, () => explain(v.cookie)));
    const statuses = responses.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 429, 429, 429, 429]);
    assert.ok(responses.filter((r) => r.status === 429).every((r) => r.body.code === "QUOTA_EXCEEDED"));
    assert.deepEqual(await usage(v.id), { day: CHARGE, week: CHARGE });
  } finally {
    config.aiMaxConcurrent = savedConcurrent;
    config.aiRateLimitPerMinute = savedPerMinute;
    const { aiRateLimiter } = await import("../../src/middleware/aiRateLimit.js");
    aiRateLimiter.reset();
  }
});

test("a reservation is settled once: repeating the settlement changes nothing", { skip }, async () => {
  const u = await createUser();
  const r = await quota.reserve(u.id, "explain", 10);
  assert.ok(r.ok);
  assert.ok(await quota.finish(r.reservationId, 5));
  assert.equal(await quota.finish(r.reservationId, 7), null);
  assert.equal(await quota.finish(r.reservationId, 0), null);
  assert.deepEqual(await usage(u.id), { day: 5, week: 5 });
});

test("a reservation the server never finished is charged in full, and a late settlement corrects it", { skip }, async () => {
  const u = await createUser();
  const started = new Date(Date.now() - quota.RESERVATION_TTL_MS - 60_000);
  const r = await quota.reserve(u.id, "explain", 12, started);
  assert.ok(r.ok);

  // Expired: the reserved amount is charged, not dropped
  const status = await quota.getStatus(u.id);
  assert.equal(status.daily.reserved, 0);
  assert.deepEqual(await usage(u.id), { day: 12, week: 12 });
  assert.equal((await reservations(u.id))[0].status, "expired");

  // The real cost arrives after all: the charge is corrected, once
  await quota.finish(r.reservationId, 3);
  assert.deepEqual(await usage(u.id), { day: 3, week: 3 });
  assert.equal((await reservations(u.id))[0].status, "settled");
  assert.equal(await quota.finish(r.reservationId, 3), null);

  // The background sweep charges stale reservations of users who don't come back
  const v = await createUser();
  await quota.reserve(v.id, "chat", 8, started);
  assert.ok((await quota.expireStale()) >= 1);
  assert.deepEqual(await usage(v.id), { day: 8, week: 8 });
});

test("a request that spends nothing (provider error) releases its reservation", { skip }, async () => {
  const u = await createUser();
  fake.fail = true;
  const res = await explain(u.cookie);
  assert.match(res.body.answer, /tidak tersedia/);
  assert.deepEqual(await usage(u.id), { day: 0, week: 0 });
  assert.deepEqual(await reservations(u.id), [{ status: "released", funded_by: "quota", reserved: reservationKredit("explain"), charged: 0 }]);
});

test("if the quota can't be checked, AI requests are refused (503), never run unmetered", { skip }, async () => {
  const u = await createUser();
  const saved = config.aiQuotaTimezone;
  config.aiQuotaTimezone = "Mars/Olympus_Mons"; // Postgres rejects it: the quota query fails
  try {
    const res = await explain(u.cookie);
    assert.equal(res.status, 503);
    assert.equal(res.body.code, "QUOTA_UNAVAILABLE");
    assert.equal(fakeCalls.length, 0, "the model is not called");
  } finally {
    config.aiQuotaTimezone = saved;
  }
});

test("all eight study tools are metered, and refused once the quota is used up", { skip }, async () => {
  const u = await createUser({ daily: 5000, weekly: 5000 });
  const tools: [string, () => unknown][] = [
    ["/explain", () => ({ materialText: material() })],
    ["/quiz", () => ({ materialText: material() })],
    ["/forum", () => ({ materialText: material() })],
    ["/exam", () => ({ materialText: material() })],
    ["/chat", () => ({ materialText: material(), messages: [{ role: "user", content: "Apa itu klorofil?" }] })],
    ["/quiz/trainer/mcq/start", () => ({ materialText: material(), numQuestions: 1 })],
    ["/flashcards", () => ({ materialText: material(), numCards: 1 })],
    ["/dialogue/start", () => ({ materialText: material() })],
    ["/dialogue/step", () => ({ materialText: material(), topics: STUDY_TOPICS, currentTopicIndex: 0, userMessage: "Mengubah cahaya" })],
    ["/dialogue/hint", () => ({ materialText: material(), currentTopicTitle: "Reaksi terang" })],
    ["/dialogue/feedback", () => ({ materialText: material(), topics: STUDY_TOPICS })],
  ];
  for (const [path, body] of tools) {
    const before = (await usage(u.id)).day;
    const calls = fakeCalls.length;
    const res = await request("POST", path, { cookie: u.cookie, json: body() });
    assert.equal(res.status, 200, `${path}: ${JSON.stringify(res.body)}`);
    const made = fakeCalls.length - calls;
    assert.ok(made >= 1, `${path} called the model`);
    assert.equal(round2((await usage(u.id)).day - before), round2(made * CHARGE), `${path} is charged what it cost`);
  }
  assert.ok((await reservations(u.id)).every((r: any) => r.status === "settled"));

  await setUsage(u.id, 5000, 5000);
  fakeCalls.length = 0;
  for (const [path, body] of tools) {
    const res = await request("POST", path, { cookie: u.cookie, json: body() });
    assert.equal(res.status, 429, path);
    assert.equal(res.body.code, "QUOTA_EXCEEDED", path);
  }
  assert.equal(fakeCalls.length, 0, "no model calls once the quota is used up");
});

test("a streamed answer settles when it ends; leaving early is charged an estimate", { skip }, async () => {
  stream.pieces = ["Jawa", "ban."];
  stream.delayMs = 0;
  const u = await createUser();
  const streamed = (cookie: string) =>
    api.fetch(
      new Request("http://local/explain", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ materialText: material(), stream: true }),
      })
    );
  const text = await (await streamed(u.cookie)).text();
  assert.match(text, /event: done/);
  assert.deepEqual(await usage(u.id), { day: CHARGE, week: CHARGE });
  const log = await query(`SELECT metadata FROM token_usage_logs WHERE user_id = $1`, [u.id]);
  assert.equal(log.rows[0].metadata.streamed, true);

  // Leave after the first piece
  stream.pieces = Array.from({ length: 60 }, (_, i) => `kata${i} `);
  stream.delayMs = 20;
  const v = await createUser();
  const reader = (await streamed(v.cookie)).body!.getReader();
  let seen = "";
  while (!/event: delta/.test(seen)) seen += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  let used = 0;
  for (let i = 0; i < 100 && !used; i++) {
    used = (await usage(v.id)).day;
    if (!used) await sleep(20);
  }
  assert.ok(used > 0 && used < CHARGE, `estimated charge expected, got ${used}`);
  assert.equal((await reservations(v.id))[0].status, "settled");
  stream.pieces = ["Jawa", "ban."];
  stream.delayMs = 0;
});

test("a stream that fails before any text releases its reservation", { skip }, async () => {
  const u = await createUser();
  fake.fail = true;
  const res = await api.fetch(
    new Request("http://local/explain", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: u.cookie },
      body: JSON.stringify({ materialText: material(), stream: true }),
    })
  );
  assert.match(await res.text(), /event: error/);
  assert.deepEqual(await usage(u.id), { day: 0, week: 0 });
  assert.equal((await reservations(u.id))[0].status, "released");
});

test("admins are metered but never refused for quota; disabled accounts are refused", { skip }, async () => {
  const admin = await createUser({ admin: true });
  await setUsage(admin.id, 10_000, 10_000);
  assert.equal((await explain(admin.cookie)).status, 200);
  assert.equal((await usage(admin.id)).day, 10_000 + CHARGE);
  assert.equal((await reservations(admin.id))[0].funded_by, "exempt");

  const u = await createUser();
  await query(`UPDATE users SET token_access_enabled = FALSE WHERE id = $1`, [u.id]);
  const res = await explain(u.cookie);
  assert.equal(res.status, 429);
  assert.equal(res.body.code, "AI_ACCESS_DISABLED");
});

test("image OCR on upload counts against the quotas, and is skipped when they're used up", { skip }, async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAAAAABWESUoAAAAKklEQVR42mP4TwAwjCgFDHAA4SGRRCtApoeIAiQfkalgqIYDpdE93PMFAN9jVNYpxnfhAAAAAElFTkSuQmCC",
    "base64"
  );
  const uploadImage = (cookie: string) => {
    const form = new FormData();
    form.append("file", new File([png], "papan.png", { type: "image/png" }));
    return request("POST", "/upload", { cookie, form });
  };

  const u = await createUser({ daily: 200, weekly: 500 });
  const ok = await uploadImage(u.cookie);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(fakeCalls.length, 1);
  assert.equal(fakeCalls[0].params.model, "qwen/qwen3.8-27b");
  // (1000*0.8 + 500*4)/1e6 USD * 4500 = 12.6 kredit
  assert.deepEqual(await usage(u.id), { day: 12.6, week: 12.6 });

  await setUsage(u.id, 200, 200);
  fakeCalls.length = 0;
  const skipped = await uploadImage(u.cookie);
  assert.equal(skipped.status, 200, "upload still succeeds");
  assert.equal(fakeCalls.length, 0, "no vision call without quota");
  assert.equal((await usage(u.id)).day, 200);
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

test("admins set the global defaults (env is the fallback), per-user overrides, and reset usage", { skip }, async () => {
  const admin = await createUser({ admin: true });
  const u = await createUser();

  assert.equal((await request("GET", "/admin/quota/settings", { cookie: u.cookie })).status, 403);
  assert.equal((await request("PUT", "/admin/quota/settings", { cookie: u.cookie, json: { daily_limit: 1 } })).status, 403);

  try {
    const set = await request("PUT", "/admin/quota/settings", { cookie: admin.cookie, json: { daily_limit: 40 } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.daily_limit, 40);
    assert.equal(set.body.daily_source, "admin");
    assert.equal(set.body.weekly_limit, config.aiWeeklyKreditLimit);
    assert.equal(set.body.weekly_source, "env");
    const stats = await request("GET", "/usage/stats", { cookie: u.cookie });
    assert.equal(stats.body.usage.daily.limit, 40);
    assert.equal(stats.body.usage.daily.limit_source, "admin");

    assert.equal((await request("PUT", "/admin/quota/settings", { cookie: admin.cookie, json: { daily_limit: -1 } })).status, 400);
    assert.equal((await request("PUT", "/admin/quota/settings", { cookie: admin.cookie, json: {} })).status, 400);
  } finally {
    const back = await request("PUT", "/admin/quota/settings", { cookie: admin.cookie, json: { daily_limit: null, weekly_limit: null } });
    assert.equal(back.body.daily_limit, config.aiDailyKreditLimit);
    assert.equal(back.body.daily_source, "env");
  }

  const override = await request("POST", `/admin/usage/user/${u.id}/update-limits`, {
    cookie: admin.cookie,
    json: { daily_limit: 7, weekly_limit: 9 },
  });
  assert.equal(override.status, 200, JSON.stringify(override.body));
  assert.deepEqual([override.body.usage.daily.limit, override.body.usage.daily.limit_source], [7, "user"]);
  assert.deepEqual([override.body.usage.weekly.limit, override.body.usage.weekly.limit_source], [9, "user"]);
  const detail = await request("GET", `/admin/usage/user/${u.id}`, { cookie: admin.cookie });
  assert.deepEqual(detail.body.overrides, { daily: 7, weekly: 9 });
  const cleared = await request("POST", `/admin/usage/user/${u.id}/update-limits`, { cookie: admin.cookie, json: { daily_limit: null } });
  assert.equal(cleared.body.usage.daily.limit, config.aiDailyKreditLimit);
  assert.equal(cleared.body.usage.weekly.limit, 9, "the weekly override is untouched");
  assert.equal(
    (await request("POST", `/admin/usage/user/${u.id}/update-limits`, { cookie: admin.cookie, json: { weekly_limit: "lots" } })).status,
    400
  );

  await setUsage(u.id, 50, 80);
  const reset = await request("POST", `/admin/usage/user/${u.id}/reset-quota`, { cookie: admin.cookie, json: { period: "daily" } });
  assert.equal(reset.status, 200);
  assert.deepEqual(await usage(u.id), { day: 0, week: 80 });
  await request("POST", `/admin/usage/user/${u.id}/reset-quota`, { cookie: admin.cookie, json: { period: "both" } });
  assert.deepEqual(await usage(u.id), { day: 0, week: 0 });
  assert.equal((await request("POST", `/admin/usage/user/${u.id}/reset-quota`, { cookie: admin.cookie, json: { period: "month" } })).status, 400);
  assert.equal((await request("POST", `/admin/usage/user/${u.id}/reset-quota`, { cookie: u.cookie, json: { period: "both" } })).status, 403);
});

test("admin dashboard and CSV export report daily and weekly use, with safe CSV quoting", { skip }, async () => {
  const admin = await createUser({ admin: true });
  const u = await createUser({ name: '=HYPERLINK("http://evil"), "Budi"' });
  const r = await quota.reserve(u.id, "explain", 20);
  assert.ok(r.ok);
  await quota.finish(r.reservationId, 12.5);

  const dash = await request("GET", "/admin/usage/dashboard?limit=500", { cookie: admin.cookie });
  assert.equal(dash.status, 200);
  const row = dash.body.users.find((x: any) => x.user_id === u.id);
  assert.equal(row.daily_kredit_used, 12.5);
  assert.equal(row.weekly_kredit_used, 12.5);
  assert.equal(row.daily_kredit_limit, config.aiDailyKreditLimit);
  assert.equal(row.requests_today, 1);
  assert.equal(dash.body.payments_enabled, false);
  assert.equal(dash.body.quota_defaults.timezone, "Asia/Jakarta");
  assert.ok(typeof dash.body.aggregate.total_kredit_used_today === "number");

  const csv = await request("GET", "/admin/usage/export", { cookie: admin.cookie });
  assert.match(String(csv.body.__raw).split("\n")[0], /Daily Kredit Used,Daily Limit/);
  const line = String(csv.body.__raw).split("\n").find((l) => l.includes(u.id))!;
  assert.ok(line.includes(`"'=HYPERLINK(""http://evil""), ""Budi"""`), line);
});

test("the AI rate limit counts per account: a new device cookie does not reset it", { skip }, async () => {
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
    assert.equal((await usage(u.id)).day, round2(2 * CHARGE), "the rejected request is not charged");

    // Same IP, different account: unaffected
    const other = await createUser();
    assert.equal((await explain(other.cookie)).status, 200);
  } finally {
    config.aiRateLimitPerMinute = saved;
    aiRateLimiter.reset();
  }
});

// ---------------------------------------------------------------------------
// Payments on and off
// ---------------------------------------------------------------------------

test("while payments are disabled, plans and extra kredit never lift the quotas", { skip }, async () => {
  const admin = await createUser({ admin: true });
  const u = await createUser();
  await kreditService.setPlan(u.id, "semester");
  await kreditService.grantProduct(u.id, "pass_7d", "earlier-sale");
  await setUsage(u.id, config.aiDailyKreditLimit, config.aiDailyKreditLimit);

  const res = await explain(u.cookie);
  assert.equal(res.status, 429, "the pass doesn't bypass the daily quota");
  const stats = await request("GET", "/usage/stats", { cookie: u.cookie });
  assert.equal(stats.body.usage.weekly.limit, config.aiWeeklyKreditLimit, "the plan doesn't set the weekly quota");
  assert.equal(stats.body.usage.payments, undefined);
  const grant = await query(`SELECT kredit_used::float AS used FROM kredit_grants WHERE user_id = $1`, [u.id]);
  assert.deepEqual(grant.rows, [{ used: 0 }], "the pass is kept untouched for later");

  for (const [path, body] of [
    [`/admin/usage/user/${u.id}/set-plan`, { plan: "bulanan" }],
    [`/admin/usage/user/${u.id}/grant-kredit`, { kredit: 50 }],
  ] as const) {
    const r = await request("POST", path, { cookie: admin.cookie, json: body });
    assert.equal(r.status, 404, path);
    assert.equal(r.body.code, "PAYMENTS_DISABLED");
  }
});

test("with payments enabled, a paid plan sets the weekly quota and extra kredit pays beyond the quotas", { skip }, async () => {
  const saved = { paymentsEnabled: config.paymentsEnabled, key: config.midtransServerKey };
  config.paymentsEnabled = true;
  config.midtransServerKey = "SB-Mid-server-TEST";
  try {
    const u = await createUser();
    await kreditService.setPlan(u.id, "semester");
    let stats = await request("GET", "/usage/stats", { cookie: u.cookie });
    assert.deepEqual([stats.body.usage.weekly.limit, stats.body.usage.weekly.limit_source], [700, "plan"]);
    assert.equal(stats.body.usage.payments.plan.code, "semester");

    await kreditService.grantProduct(u.id, "pass_7d", "test-pass");
    await setUsage(u.id, config.aiDailyKreditLimit, config.aiDailyKreditLimit);
    const res = await explain(u.cookie);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await reservations(u.id))[0].funded_by, "grant");
    const grant = await query(`SELECT kredit_used::float AS used FROM kredit_grants WHERE user_id = $1`, [u.id]);
    assert.deepEqual(grant.rows, [{ used: CHARGE }]);
    stats = await request("GET", "/usage/stats", { cookie: u.cookie });
    assert.equal(stats.body.usage.payments.extra.remaining, round2(1000 - CHARGE));
  } finally {
    config.paymentsEnabled = saved.paymentsEnabled;
    config.midtransServerKey = saved.key;
  }
});

// ---------------------------------------------------------------------------
// Hardening: legacy endpoints, settlement recovery, scheduled expiry
// ---------------------------------------------------------------------------

test("the legacy reset endpoints are deprecated (410) and never claim a reset", { skip }, async () => {
  const admin = await createUser({ admin: true });
  const u = await createUser();
  await setUsage(u.id, 30, 60);
  for (const path of ["/admin/usage/reset/weekly", "/admin/usage/reset/monthly"]) {
    assert.equal((await request("POST", path, { cookie: u.cookie })).status, 403, `${path} stays admin-only`);
    const res = await request("POST", path, { cookie: admin.cookie });
    assert.equal(res.status, 410, path);
    assert.equal(res.body.success, false);
    assert.equal(res.body.code, "ENDPOINT_DEPRECATED");
    assert.match(res.body.error, /Nothing was reset.*reset-quota/);
  }
  assert.deepEqual(await usage(u.id), { day: 30, week: 60 }, "quotas untouched");
});

test("a failed settlement stays open, is retried when the request ends, and is charged once", { skip }, async () => {
  const u = await createUser();
  await failSettlements(u.id, 1);
  const res = await explain(u.cookie);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(await usage(u.id), { day: CHARGE, week: CHARGE });
  const [r] = await reservations(u.id);
  assert.deepEqual([r.status, r.charged], ["settled", CHARGE]);
  const logs = await query(`SELECT kredit_used::float AS kredit FROM token_usage_logs WHERE user_id = $1`, [u.id]);
  assert.deepEqual(logs.rows, [{ kredit: CHARGE }], "logged once");
});

test("a streamed answer whose settlement fails is retried when the stream ends", { skip }, async () => {
  stream.pieces = ["Jawa", "ban."];
  stream.delayMs = 0;
  const u = await createUser();
  await failSettlements(u.id, 1);
  const res = await api.fetch(
    new Request("http://local/explain", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: u.cookie },
      body: JSON.stringify({ materialText: material(), stream: true }),
    })
  );
  assert.match(await res.text(), /event: done/);
  assert.deepEqual(await usage(u.id), { day: CHARGE, week: CHARGE });
  assert.equal((await reservations(u.id))[0].status, "settled");
});

test("if every settlement fails, the reservation stays open and is charged in full on expiry, once", { skip }, async () => {
  const u = await createUser();
  await failSettlements(u.id, 2);
  assert.equal((await explain(u.cookie)).status, 200);
  const [open] = await reservations(u.id);
  assert.deepEqual([open.status, open.charged], ["active", 0], "not marked settled when the database refused");
  assert.deepEqual(await usage(u.id), { day: 0, week: 0 });

  // Let it go stale (only this one: other suites share the database), then sweep twice
  await query(`UPDATE ai_quota_reservations SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1`, [u.id]);
  assert.ok((await quota.expireStale()) >= 1);
  await quota.expireStale();
  const [expired] = await reservations(u.id);
  assert.deepEqual([expired.status, expired.charged], ["expired", expired.reserved]);
  assert.deepEqual(await usage(u.id), { day: expired.reserved, week: expired.reserved }, "the hold is charged, never lost");
});

test("a usage-log failure neither undoes nor repeats the settlement", { skip }, async () => {
  const u = await createUser();
  await query(`INSERT INTO test_fail_log (user_id) VALUES ($1)`, [u.id]);
  const res = await explain(u.cookie);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-kredit-used"), CHARGE.toFixed(2), "settled normally");
  assert.deepEqual(await usage(u.id), { day: CHARGE, week: CHARGE });
  assert.equal((await reservations(u.id))[0].status, "settled");
  assert.equal((await query(`SELECT 1 FROM token_usage_logs WHERE user_id = $1`, [u.id])).rowCount, 0);
});

test("parallel expiry sweeps (several instances or scheduler runs) charge each reservation once", { skip }, async () => {
  const u = await createUser();
  const started = new Date(Date.now() - quota.RESERVATION_TTL_MS - 60_000);
  for (let i = 0; i < 3; i++) assert.ok((await quota.reserve(u.id, "explain", 4, started)).ok);
  const counts = await Promise.all([quota.expireStale(), quota.expireStale(), quota.expireStale()]);
  assert.ok(counts.reduce((a, b) => a + b, 0) >= 3);
  assert.deepEqual((await reservations(u.id)).map((r: any) => [r.status, r.charged]), [["expired", 4], ["expired", 4], ["expired", 4]]);
  assert.deepEqual(await usage(u.id), { day: 12, week: 12 }, "charged once each");
});

test("npm run quota:expire charges stale reservations and exits 0 (Cloud Run Job)", { skip }, async () => {
  const u = await createUser();
  const started = new Date(Date.now() - quota.RESERVATION_TTL_MS - 60_000);
  assert.ok((await quota.reserve(u.id, "chat", 6, started)).ok);
  const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/expire-reservations.ts"], {
    env: { ...process.env, DATABASE_URL: DB_URL, DATABASE_SSL: "false" },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /\[QUOTA\] Expired [1-9]\d* reservation\(s\)/);
  assert.deepEqual(await usage(u.id), { day: 6, week: 6 });

  const broken = spawnSync(process.execPath, ["--import", "tsx", "scripts/expire-reservations.ts"], {
    env: { ...process.env, DATABASE_URL: "postgresql://nobody@127.0.0.1:1/none", DATABASE_SSL: "false" },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(broken.status, 1, "a failed run is visible to the scheduler");
});

