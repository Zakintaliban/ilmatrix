/**
 * Payments with Midtrans against a real Postgres: checkout, webhook signature,
 * status from the Get Status API, exactly-once fulfilment (also under
 * concurrent notifications), amount checks, plan rules, ownership.
 *
 * Midtrans is a stateful fake behind a stubbed fetch. Needs TEST_DATABASE_URL.
 */
import test, { after, before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = DB_URL ? false : "TEST_DATABASE_URL not set";

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  process.env.DATABASE_SSL ??= "false";
}

const SERVER_KEY = "SB-Mid-server-TESTKEY";
const NOTIFY_URL = "https://ilmatrix.example/api/payments/midtrans/notification";

let api: any;
let query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number }>;
let config: any;
let stopBackgroundTasks: () => void;
let closeDatabase: () => Promise<void>;
const createdUsers: string[] = [];

/** Fake Midtrans: Snap creates nothing until the "customer" pays; status reads `transactions`. */
const midtrans = {
  snapRequests: [] as Array<{ url: string; headers: Record<string, string>; body: any }>,
  statusRequests: [] as string[],
  transactions: new Map<string, Record<string, string>>(),
  snapFails: false,
  statusDown: false,
  /** When > 0, status responses are held until this many are waiting, then released together. */
  statusBarrier: 0,
  waiting: [] as Array<() => void>,
};

before(async () => {
  if (skip) return;
  const migrations = await import("../../src/services/migrationService.js");
  await migrations.runMigrations();
  ({ query, closeDatabase } = await import("../../src/services/databaseService.js"));
  config = (await import("../../src/config/env.js")).default;
  const routes = await import("../../src/routes.js");
  api = routes.default;
  stopBackgroundTasks = routes.stopBackgroundTasks;

  const realFetch = globalThis.fetch;
  mock.method(globalThis, "fetch", async (input: any, init: any = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://app.sandbox.midtrans.com/snap/v1/transactions") {
      const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
      const body = JSON.parse(init.body);
      midtrans.snapRequests.push({ url, headers, body });
      if (midtrans.snapFails) return Response.json({ error_messages: ["transaction_details.gross_amount is not equal to the sum of item_details"] }, { status: 400 });
      const token = randomUUID();
      return Response.json({ token, redirect_url: `https://app.sandbox.midtrans.com/snap/v4/redirection/${token}` }, { status: 201 });
    }
    const status = url.match(/^https:\/\/api\.sandbox\.midtrans\.com\/v2\/([^/]+)\/status$/);
    if (status) {
      const orderId = decodeURIComponent(status[1]);
      midtrans.statusRequests.push(orderId);
      if (midtrans.statusDown) throw new TypeError("fetch failed");
      if (midtrans.statusBarrier > 0) {
        await new Promise<void>((resolve) => {
          midtrans.waiting.push(resolve);
          if (midtrans.waiting.length >= midtrans.statusBarrier) {
            midtrans.waiting.splice(0).forEach((release) => release());
          }
        });
      }
      const tx = midtrans.transactions.get(orderId);
      if (!tx) return Response.json({ status_code: "404", status_message: "Transaction doesn't exist." });
      return Response.json({ status_code: tx.transaction_status === "settlement" ? "200" : "201", order_id: orderId, currency: "IDR", ...tx });
    }
    return realFetch(input, init);
  });
});

beforeEach(() => {
  if (skip) return;
  config.midtransServerKey = SERVER_KEY;
  config.midtransIsProduction = false;
  config.midtransNotificationUrl = NOTIFY_URL;
  config.midtransEnabledPayments = [];
  config.baseUrl = "https://ilmatrix.example";
  midtrans.snapRequests.length = 0;
  midtrans.statusRequests.length = 0;
  midtrans.snapFails = false;
  midtrans.statusDown = false;
  midtrans.statusBarrier = 0;
});

after(async () => {
  if (skip) return;
  mock.restoreAll();
  await query(`DELETE FROM payments WHERE user_id = ANY($1::uuid[]) OR user_id IS NULL`, [createdUsers]);
  await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUsers]);
  stopBackgroundTasks();
  await closeDatabase();
  setTimeout(() => process.exit(0), 100).unref();
});

async function createUser() {
  const { rows } = await query(
    `INSERT INTO users (email, name, email_verified) VALUES ($1, 'Siswa Bayar', true) RETURNING id, email`,
    [`pay-${randomUUID()}@example.com`]
  );
  const token = randomBytes(32).toString("hex");
  await query(
    `INSERT INTO user_sessions (user_id, session_token, expires_at)
     VALUES ($1, encode(sha256(convert_to($2, 'UTF8')), 'hex'), NOW() + INTERVAL '1 day')`,
    [rows[0].id, token]
  );
  createdUsers.push(rows[0].id);
  return { id: rows[0].id as string, email: rows[0].email as string, cookie: `session=${token}` };
}

async function request(method: string, path: string, opts: { cookie?: string; json?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  const res: Response = await api.fetch(new Request(`http://local${path}`, { method, headers, body }));
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { __raw: text };
  }
  return { status: res.status, body: data };
}

const checkout = (cookie: string, product: string) => request("POST", "/payments/checkout", { cookie, json: { product } });

/** The customer pays at Midtrans (status API now reports it). */
function customerPays(orderId: string, amount: number, tx: Record<string, string> = {}) {
  midtrans.transactions.set(orderId, {
    transaction_status: "settlement",
    gross_amount: `${amount}.00`,
    payment_type: "qris",
    transaction_id: randomUUID(),
    ...tx,
  });
}

/** A notification as Midtrans would send it, signed with the server key. */
function notification(orderId: string, amount: number, extra: Record<string, string> = {}, key = SERVER_KEY) {
  const body: Record<string, string> = {
    order_id: orderId,
    status_code: "200",
    gross_amount: `${amount}.00`,
    transaction_status: "settlement",
    payment_type: "qris",
    ...extra,
  };
  body.signature_key = createHash("sha512").update(`${body.order_id}${body.status_code}${body.gross_amount}${key}`).digest("hex");
  return body;
}

const notify = (body: unknown) => request("POST", "/payments/midtrans/notification", { json: body });

async function grants(userId: string) {
  const { rows } = await query(`SELECT source, kredit_total::float AS kredit, reference FROM kredit_grants WHERE user_id = $1`, [userId]);
  return rows;
}

async function paymentRow(orderId: string) {
  return (await query(`SELECT * FROM payments WHERE order_id = $1`, [orderId])).rows[0];
}

// ---------------------------------------------------------------------------
// Catalogue and checkout
// ---------------------------------------------------------------------------

test("the catalogue lists products and plans with their prices", { skip }, async () => {
  const res = await request("GET", "/payments/products");
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, true);
  const byCode = Object.fromEntries(res.body.products.map((p: any) => [p.code, p]));
  assert.equal(byCode.pass_7d.price_idr, 9900);
  assert.equal(byCode.topup.price_idr, 5000);
  assert.equal(byCode.bulanan.price_idr, 29000);
  assert.equal(byCode.semester.price_idr, 99000);
  assert.equal(byCode.free, undefined);
});

test("checkout needs a session, a real product and configured payments", { skip }, async () => {
  assert.equal((await request("POST", "/payments/checkout", { json: { product: "pass_7d" } })).status, 401);
  const u = await createUser();
  const unknown = await checkout(u.cookie, "free");
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, "UNKNOWN_PRODUCT");

  config.midtransServerKey = "";
  const disabled = await checkout(u.cookie, "pass_7d");
  assert.equal(disabled.status, 503);
  assert.equal(disabled.body.code, "PAYMENTS_DISABLED");
  assert.equal(midtrans.snapRequests.length, 0);
});

test("checkout creates a pending payment and a Snap transaction with the exact amount", { skip }, async () => {
  const u = await createUser();
  const res = await checkout(u.cookie, "pass_7d");
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.match(res.body.order_id, /^ilx-\d{8}-[0-9a-f]{12}$/);
  assert.match(res.body.redirect_url, /^https:\/\/app\.sandbox\.midtrans\.com\/snap\//);

  const [snap] = midtrans.snapRequests;
  assert.equal(snap.headers.authorization, "Basic " + Buffer.from(`${SERVER_KEY}:`).toString("base64"));
  assert.equal(snap.headers["x-override-notification"], NOTIFY_URL);
  assert.deepEqual(snap.body.transaction_details, { order_id: res.body.order_id, gross_amount: 9900 });
  assert.deepEqual(snap.body.item_details, [{ id: "pass_7d", price: 9900, quantity: 1, name: "ILMATRIX Pass 7 Hari" }]);
  assert.equal(snap.body.customer_details.email, u.email);
  assert.equal(snap.body.callbacks.finish, "https://ilmatrix.example/payment.html");
  assert.equal(snap.body.enabled_payments, undefined, "all methods active on the account");

  const row = await paymentRow(res.body.order_id);
  assert.equal(row.status, "pending");
  assert.equal(row.amount_idr, 9900);
  assert.equal(row.user_id, u.id);
  assert.deepEqual(await grants(u.id), [], "nothing is granted before payment");
});

test("a recent pending checkout of the same product is reused", { skip }, async () => {
  const u = await createUser();
  const first = await checkout(u.cookie, "topup");
  const second = await checkout(u.cookie, "topup");
  assert.equal(second.status, 200);
  assert.equal(second.body.reused, true);
  assert.equal(second.body.order_id, first.body.order_id);
  assert.equal(midtrans.snapRequests.length, 1);
});

test("MIDTRANS_ENABLED_PAYMENTS narrows the methods offered", { skip }, async () => {
  config.midtransEnabledPayments = ["other_qris", "gopay"];
  const u = await createUser();
  await checkout(u.cookie, "pass_7d");
  assert.deepEqual(midtrans.snapRequests[0].body.enabled_payments, ["other_qris", "gopay"]);
});

test("a Snap failure returns 502 and marks the payment failed", { skip }, async () => {
  midtrans.snapFails = true;
  const u = await createUser();
  const res = await checkout(u.cookie, "pass_7d");
  assert.equal(res.status, 502);
  assert.equal(res.body.code, "PROVIDER_ERROR");
  const { rows } = await query(`SELECT status, review_note FROM payments WHERE user_id = $1`, [u.id]);
  assert.equal(rows[0].status, "failed");
  assert.match(rows[0].review_note, /gross_amount/);
});

test("at most 5 checkouts per user per hour", { skip }, async () => {
  const u = await createUser();
  // Different products avoid the reuse path; mark them failed so each checkout is new
  for (let i = 0; i < 5; i++) {
    const res = await checkout(u.cookie, i % 2 ? "topup" : "pass_7d");
    assert.equal(res.status, 201);
    await query(`UPDATE payments SET status = 'failed' WHERE order_id = $1`, [res.body.order_id]);
  }
  const sixth = await checkout(u.cookie, "pass_7d");
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.code, "TOO_MANY_CHECKOUTS");
});

// ---------------------------------------------------------------------------
// Webhook and fulfilment
// ---------------------------------------------------------------------------

test("a forged or unsigned notification is rejected and grants nothing", { skip }, async () => {
  const u = await createUser();
  const { body } = await checkout(u.cookie, "pass_7d");
  customerPays(body.order_id, 9900);

  const forged = notification(body.order_id, 9900, {}, "wrong-server-key");
  assert.equal((await notify(forged)).status, 403);
  const unsigned = { ...notification(body.order_id, 9900) } as any;
  delete unsigned.signature_key;
  assert.equal((await notify(unsigned)).status, 403);
  // Tampering with a signed field breaks the signature
  assert.equal((await notify({ ...notification(body.order_id, 9900), gross_amount: "1.00" })).status, 403);

  assert.equal((await paymentRow(body.order_id)).status, "pending");
  assert.deepEqual(await grants(u.id), []);
  assert.equal(midtrans.statusRequests.length, 0, "rejected before asking Midtrans");
});

test("a paid order is fulfilled exactly once, even with duplicate and concurrent notifications", { skip }, async () => {
  const u = await createUser();
  const { body } = await checkout(u.cookie, "pass_7d");
  customerPays(body.order_id, 9900);

  // All four get Midtrans' answer at the same moment, so their transactions overlap
  midtrans.statusBarrier = 4;
  const results = await Promise.all([1, 2, 3, 4].map(() => notify(notification(body.order_id, 9900))));
  midtrans.statusBarrier = 0;
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200]);
  assert.equal((await notify(notification(body.order_id, 9900))).status, 200, "a later duplicate");

  assert.deepEqual(await grants(u.id), [{ source: "pass_7d", kredit: 1000, reference: body.order_id }]);
  const row = await paymentRow(body.order_id);
  assert.equal(row.status, "paid");
  assert.ok(row.paid_at && row.fulfilled_at);
  assert.equal(row.payment_type, "qris");
  const events = await query(`SELECT source FROM payment_events WHERE order_id = $1`, [body.order_id]);
  assert.ok(events.rows.filter((e) => e.source === "notification").length >= 5, "every notification is logged");
});

test("the status comes from Midtrans' API, not from the notification body", { skip }, async () => {
  const u = await createUser();
  const { body } = await checkout(u.cookie, "pass_7d");
  // Signed notification says settlement, but Midtrans actually still has it pending
  midtrans.transactions.set(body.order_id, { transaction_status: "pending", gross_amount: "9900.00", payment_type: "bank_transfer" });
  assert.equal((await notify(notification(body.order_id, 9900))).status, 200);
  assert.equal((await paymentRow(body.order_id)).status, "pending");
  assert.deepEqual(await grants(u.id), []);
});

test("a wrong amount is never fulfilled and is flagged for review", { skip }, async () => {
  const u = await createUser();
  const { body } = await checkout(u.cookie, "semester");
  customerPays(body.order_id, 990);
  assert.equal((await notify(notification(body.order_id, 990))).status, 200);
  const row = await paymentRow(body.order_id);
  assert.equal(row.status, "pending");
  assert.match(row.review_note, /amount mismatch/);
  const user = (await query(`SELECT plan FROM users WHERE id = $1`, [u.id])).rows[0];
  assert.equal(user.plan, "free");
});

test("expired, denied and fraud-challenged payments are not fulfilled", { skip }, async () => {
  const cases: Array<[Record<string, string>, string]> = [
    [{ transaction_status: "expire" }, "expired"],
    [{ transaction_status: "deny" }, "failed"],
    [{ transaction_status: "cancel" }, "failed"],
    [{ transaction_status: "capture", fraud_status: "challenge", payment_type: "credit_card" }, "pending"],
  ];
  for (const [tx, expected] of cases) {
    const u = await createUser();
    const { body } = await checkout(u.cookie, "topup");
    customerPays(body.order_id, 5000, tx);
    await notify(notification(body.order_id, 5000, { transaction_status: tx.transaction_status }));
    assert.equal((await paymentRow(body.order_id)).status, expected, JSON.stringify(tx));
    assert.deepEqual(await grants(u.id), [], JSON.stringify(tx));
  }
});

test("a card capture accepted by the fraud check is fulfilled", { skip }, async () => {
  const u = await createUser();
  const { body } = await checkout(u.cookie, "topup");
  customerPays(body.order_id, 5000, { transaction_status: "capture", fraud_status: "accept", payment_type: "credit_card" });
  await notify(notification(body.order_id, 5000, { transaction_status: "capture" }));
  assert.equal((await paymentRow(body.order_id)).status, "paid");
  assert.equal((await grants(u.id)).length, 1);
});

test("if Midtrans can't be reached the webhook answers 503 so Midtrans retries", { skip }, async () => {
  const u = await createUser();
  const { body } = await checkout(u.cookie, "pass_7d");
  customerPays(body.order_id, 9900);
  midtrans.statusDown = true;
  assert.equal((await notify(notification(body.order_id, 9900))).status, 503);
  assert.equal((await paymentRow(body.order_id)).status, "pending");

  midtrans.statusDown = false;
  assert.equal((await notify(notification(body.order_id, 9900))).status, 200, "the retry succeeds");
  assert.equal((await paymentRow(body.order_id)).status, "paid");
});

test("a genuine notification for an unknown order is acknowledged and ignored", { skip }, async () => {
  const res = await notify(notification("payment_notif_test_G123", 10000));
  assert.equal(res.status, 200);
  assert.equal(res.body.ignored, "unknown order");
});

test("a refund after fulfilment is recorded and flagged, not silently revoked", { skip }, async () => {
  const u = await createUser();
  const { body } = await checkout(u.cookie, "pass_7d");
  customerPays(body.order_id, 9900);
  await notify(notification(body.order_id, 9900));
  customerPays(body.order_id, 9900, { transaction_status: "refund" });
  await notify(notification(body.order_id, 9900, { transaction_status: "refund" }));
  const row = await paymentRow(body.order_id);
  assert.equal(row.status, "refunded");
  assert.match(row.review_note, /not revoked automatically/);
  assert.equal((await grants(u.id)).length, 1);
});

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

test("buying a plan activates it; buying it again extends it", { skip }, async () => {
  const u = await createUser();
  for (const expectedDays of [30, 60]) {
    const { body } = await checkout(u.cookie, "bulanan");
    customerPays(body.order_id, 29000);
    await notify(notification(body.order_id, 29000));
    const user = (await query(`SELECT plan, plan_expires_at FROM users WHERE id = $1`, [u.id])).rows[0];
    assert.equal(user.plan, "bulanan");
    const days = (new Date(user.plan_expires_at).getTime() - Date.now()) / 86_400_000;
    assert.ok(Math.abs(days - expectedDays) < 0.1, `expected ~${expectedDays} days, got ${days}`);
  }
});

test("a different plan can't be bought while one is active; kredit products can", { skip }, async () => {
  const u = await createUser();
  await query(`UPDATE users SET plan = 'semester', plan_expires_at = NOW() + INTERVAL '100 days' WHERE id = $1`, [u.id]);
  const res = await checkout(u.cookie, "bulanan");
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "PLAN_ACTIVE");
  assert.match(res.body.error, /Semester/);
  assert.equal((await checkout(u.cookie, "pass_7d")).status, 201);
});

test("if two plan checkouts raced, the remaining paid days carry over", { skip }, async () => {
  const u = await createUser();
  const { body } = await checkout(u.cookie, "bulanan");
  // Meanwhile another order made the user Semester for 100 more days
  await query(`UPDATE users SET plan = 'semester', plan_expires_at = NOW() + INTERVAL '100 days' WHERE id = $1`, [u.id]);
  customerPays(body.order_id, 29000);
  await notify(notification(body.order_id, 29000));
  const user = (await query(`SELECT plan, plan_expires_at FROM users WHERE id = $1`, [u.id])).rows[0];
  assert.equal(user.plan, "bulanan");
  const days = (new Date(user.plan_expires_at).getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 129 && days < 131.1, `30 + 100 days expected, got ${days}`);
});

// ---------------------------------------------------------------------------
// Return page, history, admin, account deletion
// ---------------------------------------------------------------------------

test("the return page's status check pulls from Midtrans when no webhook arrived", { skip }, async () => {
  const u = await createUser();
  const { body } = await checkout(u.cookie, "pass_7d");
  const pending = await request("GET", `/payments/${body.order_id}`, { cookie: u.cookie });
  assert.equal(pending.body.payment.status, "pending");

  customerPays(body.order_id, 9900);
  await query(`UPDATE payments SET last_checked_at = NOW() - INTERVAL '1 minute' WHERE order_id = $1`, [body.order_id]);
  const paid = await request("GET", `/payments/${body.order_id}`, { cookie: u.cookie });
  assert.equal(paid.body.payment.status, "paid");
  assert.equal(paid.body.payment.product_name, "Pass 7 Hari");
  assert.equal((await grants(u.id)).length, 1);

  // Polling again doesn't call Midtrans for a settled payment
  const calls = midtrans.statusRequests.length;
  await request("GET", `/payments/${body.order_id}`, { cookie: u.cookie });
  assert.equal(midtrans.statusRequests.length, calls);
});

test("payments are private to their owner", { skip }, async () => {
  const owner = await createUser();
  const other = await createUser();
  const { body } = await checkout(owner.cookie, "topup");
  assert.equal((await request("GET", `/payments/${body.order_id}`, { cookie: other.cookie })).status, 404);
  assert.equal((await request("GET", `/payments/${body.order_id}`)).status, 401);
  const history = await request("GET", "/payments", { cookie: other.cookie });
  assert.deepEqual(history.body.payments, []);
  const own = await request("GET", "/payments", { cookie: owner.cookie });
  assert.equal(own.body.payments[0].order_id, body.order_id);
  assert.equal(own.body.payments[0].redirect_url, undefined, "internal fields are not exposed");
});

test("admins can list payments and re-check one; others can't", { skip }, async () => {
  const u = await createUser();
  const { body } = await checkout(u.cookie, "topup");
  customerPays(body.order_id, 5000);
  assert.equal((await request("GET", "/admin/payments", { cookie: u.cookie })).status, 403);

  const admin = await createUser();
  await query(`UPDATE users SET is_admin = true WHERE id = $1`, [admin.id]);
  const list = await request("GET", "/admin/payments?status=pending", { cookie: admin.cookie });
  assert.ok(list.body.payments.some((p: any) => p.order_id === body.order_id));
  const synced = await request("POST", `/admin/payments/${body.order_id}/sync`, { cookie: admin.cookie });
  assert.equal(synced.body.payment.status, "paid");
  assert.equal((await grants(u.id)).length, 1);
});

test("deleting the account keeps the payment record without the user", { skip }, async () => {
  const u = await createUser();
  const { body } = await checkout(u.cookie, "topup");
  assert.equal((await request("DELETE", "/auth/delete-account", { cookie: u.cookie })).status, 200);
  const row = await paymentRow(body.order_id);
  assert.equal(row.user_id, null);
  assert.equal(row.amount_idr, 5000);

  // Paid afterwards: recorded, nothing to fulfil
  customerPays(body.order_id, 5000);
  await notify(notification(body.order_id, 5000));
  const paid = await paymentRow(body.order_id);
  assert.equal(paid.status, "paid");
  assert.match(paid.review_note, /account was deleted/);
});
