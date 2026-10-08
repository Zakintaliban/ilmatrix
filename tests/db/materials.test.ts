/**
 * Persistent material storage against a real Postgres database.
 *
 *   TEST_DATABASE_URL=postgresql://user@localhost:5432/ilmatrix_test npm run test:db
 *
 * The database is migrated by the test and receives test rows, so point it at
 * a disposable database. Without TEST_DATABASE_URL these tests are skipped.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = DB_URL ? false : "TEST_DATABASE_URL not set";

// Configure before any app module reads the environment
if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  process.env.DATABASE_SSL ??= "false";
  process.env.MATERIAL_USER_QUOTA_MB = "1";
}

let api: any;
let query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number }>;
let materialService: any;
let getMaterialStore: any;
let MaterialQuotaError: any;
let stopBackgroundTasks: () => void;
let closeDatabase: () => Promise<void>;

const users: Record<"a" | "b", { id: string; cookie: string }> = {} as any;

before(async () => {
  if (skip) return;
  const migrations = await import("../../src/services/migrationService.js");
  await migrations.runMigrations();

  ({ query, closeDatabase } = await import("../../src/services/databaseService.js"));
  ({ materialService } = await import("../../src/services/materialService.js"));
  ({ getMaterialStore, MaterialQuotaError } = await import("../../src/services/materialStore.js"));
  const routes = await import("../../src/routes.js");
  api = routes.default;
  stopBackgroundTasks = routes.stopBackgroundTasks;

  // Fake Groq so AI endpoints can run without network access
  const { groqService } = await import("../../src/services/groqService.js");
  const { GroqProvider } = await import("../../src/services/groqProvider.js");
  const { createFakeGroq, completion, TEST_PROVIDER_CONFIG } = await import("../ai/fakeGroq.js");
  (groqService as any).provider = new GroqProvider({
    client: createFakeGroq(() => completion("Jawaban berdasarkan materi.")).client,
    config: TEST_PROVIDER_CONFIG,
  });

  for (const key of ["a", "b"] as const) {
    const email = `material-test-${key}-${randomUUID()}@example.com`;
    const { rows } = await query(`INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`, [email, `User ${key}`]);
    const token = randomBytes(32).toString("hex");
    await query(
      `INSERT INTO user_sessions (user_id, session_token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
      [rows[0].id, token]
    );
    users[key] = { id: rows[0].id, cookie: `session=${token}` };
  }
});

after(async () => {
  if (skip) return;
  // Deleting the users cascades to their sessions and materials
  await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[users.a?.id, users.b?.id].filter(Boolean)]);
  stopBackgroundTasks();
  await closeDatabase();
  setTimeout(() => process.exit(0), 100).unref();
});

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
  return { status: res.status, body: data };
}

async function upload(text: string, cookie?: string, extra: Record<string, string> = {}) {
  const form = new FormData();
  form.append("file", new File([text], "catatan.txt", { type: "text/plain" }));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return request("POST", "/upload", { cookie, form });
}

async function row(id: string) {
  const { rows } = await query(
    `SELECT user_id, content, size_bytes,
            EXTRACT(EPOCH FROM (expires_at - NOW())) AS expires_in
     FROM materials WHERE id = $1`,
    [id]
  );
  return rows[0] as { user_id: string | null; content: string; size_bytes: number; expires_in: string | null } | undefined;
}

const DAY = 24 * 60 * 60;

test("migrations create the materials table and the app selects Postgres storage", { skip }, async () => {
  const store = await getMaterialStore();
  assert.equal(store.kind, "postgres");
});

test("guest uploads are stored in Postgres with the short guest TTL", { skip }, async () => {
  const res = await upload("Catatan tamu tentang fotosintesis.");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const r = await row(res.body.materialId);
  assert.ok(r, "material row exists");
  assert.equal(r.user_id, null);
  assert.ok(Number(r.expires_in) > 50 * 60 && Number(r.expires_in) <= 60 * 60, `expires in ${r.expires_in}s`);
  assert.equal((await request("GET", `/material/${res.body.materialId}`)).status, 200);
});

test("signed-in uploads persist for months and are private to their owner", { skip }, async () => {
  const res = await upload("Catatan pribadi kalkulus: turunan dan integral.", users.a.cookie);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const id = res.body.materialId;
  const r = await row(id);
  assert.equal(r?.user_id, users.a.id);
  assert.ok(Number(r?.expires_in) > 179 * DAY, `expires in ${r?.expires_in}s`);

  assert.equal((await request("GET", `/material/${id}`, { cookie: users.a.cookie })).status, 200);
  assert.equal((await request("GET", `/material/${id}`)).status, 404, "guests cannot read it");
  assert.equal((await request("GET", `/material/${id}`, { cookie: users.b.cookie })).status, 404, "other users cannot read it");

  const own = await request("POST", "/explain", { cookie: users.a.cookie, json: { materialId: id } });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  const other = await request("POST", "/explain", { cookie: users.b.cookie, json: { materialId: id } });
  assert.notEqual(other.status, 200);
  assert.match(other.body.error, /not found/i);
});

test("a signed-in user who uses a guest upload claims it", { skip }, async () => {
  const id = (await upload("Diunggah sebelum login.")).body.materialId;
  assert.equal((await request("GET", `/material/${id}`, { cookie: users.a.cookie })).status, 200);
  const r = await row(id);
  assert.equal(r?.user_id, users.a.id);
  assert.ok(Number(r?.expires_in) > 179 * DAY);
  assert.equal((await request("GET", `/material/${id}`)).status, 404, "no longer anonymous");
});

test("appending respects ownership", { skip }, async () => {
  const guestId = (await upload("Bagian satu.")).body.materialId;
  const appended = await upload("Bagian dua.", undefined, { append: "true", mergeTo: guestId });
  assert.equal(appended.body.materialId, guestId);
  assert.equal(appended.body.appended, true);
  assert.match((await row(guestId))!.content, /Bagian satu[\s\S]*Bagian dua/);

  const ownedId = (await upload("Milik A.", users.a.cookie)).body.materialId;
  const intrusion = await upload("Dari B.", users.b.cookie, { append: "true", mergeTo: ownedId });
  assert.equal(intrusion.body.appended, false, "B gets a new material instead");
  assert.notEqual(intrusion.body.materialId, ownedId);
  assert.doesNotMatch((await row(ownedId))!.content, /Dari B/);
});

test("removing a file from a material is owner-only", { skip }, async () => {
  const form = new FormData();
  form.append("file", new File(["Isi satu"], "satu.txt", { type: "text/plain" }));
  form.append("file", new File(["Isi dua"], "dua.txt", { type: "text/plain" }));
  const id = (await request("POST", "/upload", { cookie: users.a.cookie, form })).body.materialId;

  const denied = await request("POST", `/material/${id}/remove`, { cookie: users.b.cookie, json: { name: "satu.txt" } });
  assert.equal(denied.status, 404);

  const ok = await request("POST", `/material/${id}/remove`, { cookie: users.a.cookie, json: { name: "satu.txt" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.files.map((f: any) => f.name), ["dua.txt"]);
});

test("saving to the library keeps a material indefinitely; removing it restores retention", { skip }, async () => {
  const id = (await upload("Materi penting untuk UAS.", users.a.cookie)).body.materialId;
  const saved = await request("POST", "/dashboard/materials", {
    cookie: users.a.cookie,
    json: { materialId: id, title: "UAS", fileNames: ["catatan.txt"], fileTypes: ["text"] },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await row(id))?.expires_in, null, "pinned");

  const removed = await request("DELETE", `/dashboard/materials/${id}`, { cookie: users.a.cookie });
  assert.equal(removed.status, 200);
  assert.ok(Number((await row(id))?.expires_in) > 179 * DAY, "unpinned");

  const missing = await request("POST", "/dashboard/materials", {
    cookie: users.b.cookie,
    json: { materialId: id, title: "Bukan milik B", fileNames: ["x"], fileTypes: ["text"] },
  });
  assert.equal(missing.status, 404, "cannot save someone else's material");
});

test("deleting is owner-only and also removes the library entry", { skip }, async () => {
  const id = (await upload("Akan dihapus.", users.a.cookie)).body.materialId;
  await request("POST", "/dashboard/materials", {
    cookie: users.a.cookie,
    json: { materialId: id, title: "Hapus", fileNames: ["catatan.txt"], fileTypes: ["text"] },
  });

  await request("DELETE", `/material/${id}`, { cookie: users.b.cookie });
  assert.ok(await row(id), "other users cannot delete it");

  assert.equal((await request("DELETE", `/material/${id}`, { cookie: users.a.cookie })).status, 200);
  assert.equal(await row(id), undefined);
  const lib = await query(`SELECT 1 FROM user_materials WHERE material_id = $1`, [id]);
  assert.equal(lib.rowCount, 0);
});

test("expired materials are unreadable and removed by cleanup", { skip }, async () => {
  const id = (await upload("Sudah kedaluwarsa.")).body.materialId;
  await query(`UPDATE materials SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [id]);
  assert.equal((await request("GET", `/material/${id}`)).status, 404);
  assert.ok((await materialService.cleanupOldMaterials()) >= 1);
  assert.equal(await row(id), undefined);
});

test("materials survive a fresh store instance (i.e. a restart or redeploy)", { skip }, async () => {
  const id = (await upload("Bertahan setelah restart.", users.a.cookie)).body.materialId;
  const { PostgresMaterialStore } = await import("../../src/services/materialStore.js");
  assert.equal(await new PostgresMaterialStore().read(id, users.a.id), "===== FILE: catatan.txt =====\nBertahan setelah restart.");
});

test("per-user storage quota is enforced", { skip }, async () => {
  const big = "x".repeat(600 * 1024);
  await materialService.createMaterial(big, users.b.id);
  await assert.rejects(materialService.createMaterial(big, users.b.id), MaterialQuotaError);
  const res = await upload(big, users.b.cookie);
  assert.equal(res.status, 413);
  assert.match(res.body.error, /Storage limit/);
  // Guests are not subject to the per-user quota (they expire within the hour)
  assert.equal((await upload(big)).status, 200);
});

test("NUL characters in extracted text do not break storage", { skip }, async () => {
  const id = await materialService.createMaterial("teks\u0000dengan\u0000nul", users.a.id);
  assert.equal(await materialService.readMaterial(id, undefined, users.a.id), "teksdengannul");
});

test("deleting an account deletes its materials", { skip }, async () => {
  const { rows } = await query(`INSERT INTO users (email, name) VALUES ($1, 'Temp') RETURNING id`, [
    `material-test-temp-${randomUUID()}@example.com`,
  ]);
  const id = await materialService.createMaterial("Data pribadi.", rows[0].id);
  await query(`DELETE FROM users WHERE id = $1`, [rows[0].id]);
  assert.equal(await row(id), undefined);
});
