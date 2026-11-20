/**
 * Account security against a real Postgres: verified-email login, failed-login
 * throttling, Google sign-in (state check, account pre-hijacking), profile and
 * password changes, account deletion, verification resend.
 *
 * Needs TEST_DATABASE_URL (a disposable database: migrated, gets test rows).
 * Google's endpoints are replaced by a stubbed fetch.
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = DB_URL ? false : "TEST_DATABASE_URL not set";

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  process.env.DATABASE_SSL ??= "false";
}

let api: any;
let query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number }>;
let config: any;
let loginThrottle: any;
let stopBackgroundTasks: () => void;
let closeDatabase: () => Promise<void>;
const createdEmails: string[] = [];
const PASSWORD = "correct-horse-battery";
let passwordHash: string;

before(async () => {
  if (skip) return;
  const migrations = await import("../../src/services/migrationService.js");
  await migrations.runMigrations();
  ({ query, closeDatabase } = await import("../../src/services/databaseService.js"));
  config = (await import("../../src/config/env.js")).default;
  ({ loginThrottle } = await import("../../src/services/loginThrottle.js"));
  const routes = await import("../../src/routes.js");
  api = routes.default;
  stopBackgroundTasks = routes.stopBackgroundTasks;
  passwordHash = await bcrypt.hash(PASSWORD, 4);
  config.googleClientId = "test-client-id";
  config.googleClientSecret = "test-client-secret";
});

beforeEach(() => {
  if (skip) return;
  loginThrottle.reset();
  config.resendApiKey = "";
  config.emailFromAddress = "";
});

after(async () => {
  if (skip) return;
  await query(`DELETE FROM users WHERE email = ANY($1::text[])`, [createdEmails]);
  stopBackgroundTasks();
  await closeDatabase();
  setTimeout(() => process.exit(0), 100).unref();
});

/** Pretend verification emails can be sent (nothing is actually sent: no Resend client). */
function requireVerification() {
  config.resendApiKey = "re_test";
  config.emailFromAddress = "noreply@example.com";
}

function newEmail(): string {
  const email = `auth-${randomUUID()}@example.com`;
  createdEmails.push(email);
  return email;
}

async function createUser(opts: { verified?: boolean; password?: boolean; email?: string } = {}) {
  const email = opts.email ?? newEmail();
  const { rows } = await query(
    `INSERT INTO users (email, name, password_hash, email_verified, auth_method)
     VALUES ($1, 'Siswa', $2, $3, $4) RETURNING id`,
    [email, opts.password === false ? null : passwordHash, opts.verified ?? true, opts.password === false ? "google" : "email"]
  );
  return { id: rows[0].id as string, email };
}

async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await query(
    `INSERT INTO user_sessions (user_id, session_token, expires_at)
       VALUES ($1, encode(sha256(convert_to($2, 'UTF8')), 'hex'), NOW() + INTERVAL '1 day')`,
    [userId, token]
  );
  return token;
}

async function request(method: string, path: string, opts: { cookie?: string; json?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  const res: Response = await api.fetch(new Request(`http://local${path}`, { method, headers, body, redirect: "manual" }));
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { __raw: text };
  }
  const cookies = res.headers.getSetCookie();
  const session = cookies.map((c) => c.match(/^session=([^;]+)/)?.[1]).find(Boolean);
  return { status: res.status, body: data, headers: res.headers, cookies, session };
}

const login = (email: string, password = PASSWORD) => request("POST", "/auth/login", { json: { email, password } });
const profile = (token: string) => request("GET", "/auth/profile", { cookie: `session=${token}` });

async function userRow(id: string) {
  const { rows } = await query(`SELECT email_verified, password_hash, auth_method FROM users WHERE id = $1`, [id]);
  return rows[0];
}

// ---------------------------------------------------------------------------
// Password login
// ---------------------------------------------------------------------------

test("password login needs a verified email when verification emails can be sent", { skip }, async () => {
  requireVerification();
  const u = await createUser({ verified: false });

  const wrong = await login(u.email, "wrong-password");
  assert.equal(wrong.status, 401, "a wrong password doesn't reveal that the account is unverified");
  assert.equal(wrong.body.code, "INVALID_CREDENTIALS");

  const unverified = await login(u.email);
  assert.equal(unverified.status, 403);
  assert.equal(unverified.body.code, "EMAIL_NOT_VERIFIED");
  assert.equal(unverified.session, undefined, "no session is created");

  await query(`UPDATE users SET email_verified = true WHERE id = $1`, [u.id]);
  const ok = await login(u.email);
  assert.equal(ok.status, 200);
  assert.ok(ok.session);
  assert.equal((await profile(ok.session!)).status, 200);
});

test("signing in from a fresh browser (no device cookie yet) returns the session cookie", { skip }, async () => {
  // Regression: the guest device cookie used to replace the session cookie on the same response
  const u = await createUser();
  const res = await login(u.email);
  assert.equal(res.status, 200);
  assert.ok(res.session, `session cookie missing: ${res.cookies.join(" | ")}`);
  assert.equal(res.cookies.filter((c) => c.startsWith("device_id=")).length, 1, "one device id per response");
  assert.equal((await profile(res.session!)).status, 200);
});

test("without an email service unverified accounts can still sign in (nobody could verify)", { skip }, async () => {
  const u = await createUser({ verified: false });
  assert.equal((await login(u.email)).status, 200);
});

test("Google-only accounts are refused password sign-in with 401, not a server error", { skip }, async () => {
  const u = await createUser({ password: false });
  const res = await login(u.email, "anything-at-all");
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "INVALID_CREDENTIALS");
  assert.equal((await login(newEmail(), "anything-at-all")).status, 401, "unknown email: same answer");
});

test("failed sign-ins are throttled per email, and success clears the count", { skip }, async () => {
  const u = await createUser();
  for (let i = 0; i < 9; i++) assert.equal((await login(u.email, `wrong-${i}`)).status, 401);
  assert.equal((await login(u.email)).status, 200, "success before the limit");

  for (let i = 0; i < 10; i++) assert.equal((await login(u.email, `wrong-${i}`)).status, 401);
  const throttled = await login(u.email);
  assert.equal(throttled.status, 429, "even the right password waits");
  assert.equal(throttled.body.code, "LOGIN_THROTTLED");
  assert.ok(Number(throttled.headers.get("retry-after")) > 0);

  const other = await createUser();
  assert.equal((await login(other.email)).status, 200, "other accounts are unaffected");
});

// ---------------------------------------------------------------------------
// Google sign-in
// ---------------------------------------------------------------------------

function stubGoogle(t: any, email: string, opts: { tokenStatus?: number } = {}) {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      if (opts.tokenStatus) return new Response('{"error":"<script>alert(1)</script>"}', { status: opts.tokenStatus });
      return Response.json({ access_token: "google-access-token", token_type: "Bearer", expires_in: 3600, scope: "openid" });
    }
    if (url.startsWith("https://www.googleapis.com/oauth2/v2/userinfo")) {
      return Response.json({ id: randomUUID().replace(/-/g, ""), email, verified_email: true, name: "Pemilik Asli" });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}

/** Start sign-in like a browser: returns the state and its cookie. */
async function startGoogle() {
  const res = await request("GET", "/auth/google");
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location")!);
  const state = location.searchParams.get("state")!;
  assert.match(state, /^[0-9a-f]{64}$/);
  const cookie = res.cookies.find((c) => c.startsWith("oauth_state="))!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Path=\/api\/auth\/google/);
  return { state, cookie: cookie.split(";")[0] };
}

async function googleCallback(state: string, cookie?: string) {
  return request("GET", `/auth/google/callback?code=test-code&state=${state}`, { cookie });
}

test("Google sign-in takes over an unverified password account (pre-hijacking)", { skip }, async (t) => {
  // Attacker registers the victim's address with a password they know and keeps a session
  const victimEmail = newEmail();
  const planted = await createUser({ email: victimEmail, verified: false });
  const attackerSession = await createSession(planted.id);
  assert.equal((await login(victimEmail)).status, 200, "attacker can sign in before the takeover");

  // The real owner signs in with Google
  stubGoogle(t, victimEmail);
  const { state, cookie } = await startGoogle();
  const res = await googleCallback(state, cookie);
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location")!, /^\/dashboard\.html\?login=success/);
  assert.ok(res.session, "owner is signed in");
  assert.equal((await profile(res.session!)).status, 200);

  // Attacker is locked out: sessions revoked, password removed
  assert.equal((await profile(attackerSession)).status, 401);
  assert.equal((await login(victimEmail)).status, 401);
  const row = await userRow(planted.id);
  assert.equal(row.email_verified, true);
  assert.equal(row.password_hash, null);
  assert.equal(row.auth_method, "google");
});

test("Google sign-in into a verified password account keeps its password", { skip }, async (t) => {
  const u = await createUser();
  stubGoogle(t, u.email);
  const { state, cookie } = await startGoogle();
  const res = await googleCallback(state, cookie);
  assert.equal(res.status, 302);
  assert.ok(res.session);
  assert.equal((await login(u.email)).status, 200);
});

test("Google sign-in creates a verified account for a new email", { skip }, async (t) => {
  const email = newEmail();
  stubGoogle(t, email);
  const { state, cookie } = await startGoogle();
  const res = await googleCallback(state, cookie);
  assert.match(res.headers.get("location")!, /welcome=true/);
  const { rows } = await query(`SELECT email_verified, password_hash FROM users WHERE email = $1`, [email]);
  assert.deepEqual(rows, [{ email_verified: true, password_hash: null }]);
});

test("a callback without the matching state cookie is refused before contacting Google", { skip }, async (t) => {
  const calls = stubGoogle(t, newEmail());
  const { state, cookie } = await startGoogle();

  const noCookie = await googleCallback(state);
  assert.equal(noCookie.headers.get("location"), "/login.html?error=oauth_state");
  const wrongState = await googleCallback("a".repeat(64), cookie);
  assert.equal(wrongState.headers.get("location"), "/login.html?error=oauth_state");
  const noState = await request("GET", "/auth/google/callback?code=test-code", { cookie });
  assert.equal(noState.headers.get("location"), "/login.html?error=oauth_state");

  assert.equal(calls.length, 0);
  assert.equal(noCookie.session, undefined);
  assert.ok(noCookie.cookies.some((c) => /^oauth_state=;.*Max-Age=0/.test(c)), "state cookie is cleared");
});

test("Google errors redirect with a fixed code, not the provider's message", { skip }, async (t) => {
  stubGoogle(t, newEmail(), { tokenStatus: 400 });
  const { state, cookie } = await startGoogle();
  const res = await googleCallback(state, cookie);
  assert.equal(res.headers.get("location"), "/login.html?error=oauth_failed");
});

// ---------------------------------------------------------------------------
// Profile, password, deletion, resend
// ---------------------------------------------------------------------------

test("the email can't be changed through the profile, and fields are bounded", { skip }, async () => {
  const u = await createUser();
  const token = await createSession(u.id);
  const put = (json: unknown) => request("PUT", "/auth/profile", { cookie: `session=${token}`, json });

  const changed = await put({ email: newEmail() });
  assert.equal(changed.status, 400);
  assert.equal(changed.body.error, "Email cannot be changed");

  assert.equal((await put({ email: u.email.toUpperCase(), name: "Nama Baru" })).status, 200, "same email is fine");
  assert.equal((await put({ name: "x".repeat(101) })).status, 400);
  assert.equal((await put({ phone: "1".repeat(21) })).status, 400, "longer than the VARCHAR(20) column");
  assert.equal((await put({ bio: "b".repeat(1001) })).status, 400);
  assert.equal((await put({ phone: "08123456789", bio: "Mahasiswa" })).status, 200);
});

test("changing the password signs out every other session", { skip }, async () => {
  const u = await createUser();
  const current = await createSession(u.id);
  const other = await createSession(u.id);

  const res = await request("POST", "/auth/change-password", {
    cookie: `session=${current}`,
    json: { currentPassword: PASSWORD, newPassword: "a-new-password-123" },
  });
  assert.equal(res.status, 200);
  assert.equal((await profile(current)).status, 200);
  assert.equal((await profile(other)).status, 401);
  assert.equal((await login(u.email, "a-new-password-123")).status, 200);
});

test("Google-only accounts get a clear error from change-password", { skip }, async () => {
  const u = await createUser({ password: false });
  const token = await createSession(u.id);
  const res = await request("POST", "/auth/change-password", {
    cookie: `session=${token}`,
    json: { currentPassword: "x", newPassword: "a-new-password-123" },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Google/);
});

test("deleting an account works when guest chats were migrated into it", { skip }, async () => {
  const u = await createUser();
  const token = await createSession(u.id);
  await query(
    `INSERT INTO guest_chat_sessions (guest_fingerprint, title, is_migrated, migrated_to_user_id) VALUES ('fp-delete-test', 'Chat', true, $1)`,
    [u.id]
  );

  const res = await request("DELETE", "/auth/delete-account", { cookie: `session=${token}` });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await query(`SELECT 1 FROM users WHERE id = $1`, [u.id])).rowCount, 0);
  assert.equal((await query(`SELECT 1 FROM guest_chat_sessions WHERE migrated_to_user_id = $1`, [u.id])).rowCount, 0);
});

test("resend verification answers the same for unknown, verified and unverified emails", { skip }, async () => {
  const unverified = await createUser({ verified: false });
  const verified = await createUser();
  const answers = new Set<string>();
  for (const email of [newEmail(), verified.email, unverified.email, unverified.email]) {
    const res = await request("POST", "/auth/resend-verification", { json: { email } });
    assert.equal(res.status, 200);
    answers.add(res.body.message);
  }
  assert.equal(answers.size, 1);
});

// ---------------------------------------------------------------------------
// Session tokens at rest (S15)
// ---------------------------------------------------------------------------

test("sessions are stored as SHA-256 hashes; the stored value is not a usable cookie", { skip }, async () => {
  const u = await createUser();
  const res = await login(u.email);
  const token = res.session!;
  const { rows } = await query(`SELECT session_token FROM user_sessions WHERE user_id = $1`, [u.id]);
  assert.equal(rows.length, 1);
  const { createHash } = await import("node:crypto");
  assert.equal(rows[0].session_token, createHash("sha256").update(token).digest("hex"));
  assert.notEqual(rows[0].session_token, token);

  assert.equal((await profile(rows[0].session_token)).status, 401, "a leaked database row can't be replayed");
  assert.equal((await profile(token)).status, 200);

  assert.equal((await request("POST", "/auth/logout", { cookie: `session=${token}` })).status, 200);
  assert.equal((await query(`SELECT 1 FROM user_sessions WHERE user_id = $1`, [u.id])).rowCount, 0, "logout finds the hashed row");
});

test("migration 013 hashes existing plaintext tokens once, and re-running it changes nothing", { skip }, async () => {
  const { readFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { getDatabase } = await import("../../src/services/databaseService.js");
  const sql = readFileSync(new URL("../../migrations/013_hash_session_tokens.sql", import.meta.url), "utf8");
  const u = await createUser();
  const plaintext = randomBytes(32).toString("hex");
  const hashed = createHash("sha256").update(plaintext).digest("hex");

  const client = await getDatabase().connect();
  try {
    await client.query("BEGIN");
    // Simulate a database from before the migration: no marker, a plaintext token
    await client.query(`COMMENT ON COLUMN user_sessions.session_token IS NULL`);
    await client.query(`INSERT INTO user_sessions (user_id, session_token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 day')`, [u.id, plaintext]);
    await client.query(sql);
    const once = await client.query(`SELECT session_token FROM user_sessions WHERE user_id = $1`, [u.id]);
    assert.equal(once.rows[0].session_token, hashed);
    await client.query(sql);
    const twice = await client.query(`SELECT session_token FROM user_sessions WHERE user_id = $1`, [u.id]);
    assert.equal(twice.rows[0].session_token, hashed, "not hashed twice");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
