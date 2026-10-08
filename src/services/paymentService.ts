import { randomBytes } from "node:crypto";
import config from "../config/env.js";
import { KREDIT_PRODUCTS, PLANS, isKreditProductCode, isPlanCode, type PlanCode } from "../config/plans.js";
import { query, transaction } from "./databaseService.js";
import { grantProduct, setPlan } from "./kreditService.js";
import { createSnapTransaction, getTransactionStatus, type MidtransStatus } from "./midtransClient.js";

/**
 * Payments with Midtrans Snap (redirect flow).
 *
 * Checkout creates a pending payment and sends the student to Midtrans'
 * hosted page. The source of truth is Midtrans' Get Status API: notifications
 * (webhook) only tell us when to ask, and the return page asks too if a
 * payment is still pending, so a missing or late webhook doesn't lose a sale.
 * Fulfilment (plan or kredit) happens once, under a row lock.
 */

export type PaymentStatus = "pending" | "paid" | "failed" | "expired" | "refunded";
export type ProductCode = Exclude<PlanCode, "free"> | keyof typeof KREDIT_PRODUCTS;

export interface CatalogItem {
  code: ProductCode;
  kind: "plan" | "kredit";
  name: string;
  priceIdr: number;
  description: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Most pending checkouts one user may open per hour. */
const MAX_PENDING_PER_HOUR = 5;
/** A pending checkout of the same product younger than this is reused. */
const REUSE_PENDING_MS = 60 * 60 * 1000;
/** The return page re-checks a pending payment at most this often. */
const RECHECK_MS = 10_000;
/** Snap pages expire after 24 hours by default. */
const PENDING_EXPIRY_MS = 25 * 60 * 60 * 1000;

export class PaymentError extends Error {
  constructor(public code: string, public httpStatus: 400 | 404 | 409 | 429 | 502 | 503, message: string) {
    super(message);
    this.name = "PaymentError";
  }
}

const rupiah = (n: number) => n.toLocaleString("id-ID");

export function getCatalog(): CatalogItem[] {
  const plans = (Object.values(PLANS).filter((p) => p.code !== "free") as Array<(typeof PLANS)["bulanan"]>).map(
    (p): CatalogItem => ({
      code: p.code as ProductCode,
      kind: "plan",
      name: `Paket ${p.name}`,
      priceIdr: p.priceIdr,
      description: `${rupiah(p.weeklyKredit)} kredit per minggu selama ${p.durationDays} hari`,
    })
  );
  const products = Object.values(KREDIT_PRODUCTS).map(
    (p): CatalogItem => ({
      code: p.code,
      kind: "kredit",
      name: p.name,
      priceIdr: p.priceIdr,
      description: `${rupiah(p.kredit)} kredit tambahan${p.validDays ? `, berlaku ${p.validDays} hari` : ""}`,
    })
  );
  return [...products, ...plans];
}

function catalogItem(code: unknown): CatalogItem | undefined {
  return getCatalog().find((item) => item.code === code);
}

export function isPaymentsEnabled(): boolean {
  return !!config.midtransServerKey;
}

/** Snap.js for the payment popup on our checkout page (null: use Midtrans' hosted page). */
export function snapJsConfig(): { url: string; clientKey: string } | null {
  if (!config.midtransClientKey) return null;
  return {
    url: config.midtransIsProduction ? "https://app.midtrans.com/snap/snap.js" : "https://app.sandbox.midtrans.com/snap/snap.js",
    clientKey: config.midtransClientKey,
  };
}

/** Midtrans transaction_status (+ fraud_status) -> our payment status. */
export function mapMidtransStatus(transactionStatus?: string, fraudStatus?: string): PaymentStatus {
  switch (transactionStatus) {
    case "settlement":
      return "paid";
    case "capture":
      // Card: paid unless the fraud check questions or rejects it
      if (!fraudStatus || fraudStatus === "accept") return "paid";
      return fraudStatus === "deny" ? "failed" : "pending";
    case "deny":
    case "cancel":
    case "failure":
      return "failed";
    case "expire":
      return "expired";
    case "refund":
    case "partial_refund":
    case "chargeback":
    case "partial_chargeback":
      return "refunded";
    default:
      // pending, authorize, or anything new: wait
      return "pending";
  }
}

function newOrderId(): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `ilx-${day}-${randomBytes(6).toString("hex")}`;
}

interface CheckoutUser {
  id: string;
  name?: string;
  email?: string;
}

/** Start a payment; returns the Midtrans page to send the student to. */
export async function createCheckout(
  user: CheckoutUser,
  productCode: unknown
): Promise<{ orderId: string; redirectUrl: string; snapToken: string | null; amountIdr: number; product: CatalogItem; reused: boolean }> {
  const product = catalogItem(productCode);
  if (!product) throw new PaymentError("UNKNOWN_PRODUCT", 400, "Produk tidak dikenal.");
  if (!isPaymentsEnabled()) {
    throw new PaymentError("PAYMENTS_DISABLED", 503, "Pembayaran belum tersedia. Coba lagi nanti.");
  }

  if (product.kind === "plan") {
    // Switching plans mid-period would throw away paid days (or upgrade weekly kredit for the rest of a semester)
    const { rows } = await query(`SELECT plan, plan_expires_at FROM users WHERE id = $1`, [user.id]);
    const current = rows[0];
    if (current && current.plan !== "free" && current.plan !== product.code && new Date(current.plan_expires_at) > new Date()) {
      const until = new Date(current.plan_expires_at).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
      throw new PaymentError(
        "PLAN_ACTIVE",
        409,
        `Paket ${PLANS[current.plan as PlanCode]?.name ?? current.plan} kamu masih aktif sampai ${until}. ` +
          "Untuk kredit tambahan, beli Pass 7 Hari atau Top-up."
      );
    }
  }

  // Reuse a recent pending checkout of the same product (e.g. the student went back)
  const existing = await query(
    `SELECT order_id, redirect_url, snap_token, amount_idr FROM payments
     WHERE user_id = $1 AND product = $2 AND status = 'pending' AND redirect_url IS NOT NULL
       AND amount_idr = $3 AND created_at > NOW() - make_interval(secs => $4)
     ORDER BY created_at DESC LIMIT 1`,
    [user.id, product.code, product.priceIdr, REUSE_PENDING_MS / 1000]
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    return {
      orderId: row.order_id,
      redirectUrl: row.redirect_url,
      snapToken: row.snap_token ?? null,
      amountIdr: row.amount_idr,
      product,
      reused: true,
    };
  }

  const recent = await query(
    `SELECT COUNT(*)::int AS n FROM payments WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [user.id]
  );
  if (recent.rows[0].n >= MAX_PENDING_PER_HOUR) {
    throw new PaymentError("TOO_MANY_CHECKOUTS", 429, "Terlalu banyak percobaan pembayaran. Coba lagi dalam satu jam.");
  }

  const orderId = newOrderId();
  await query(`INSERT INTO payments (order_id, user_id, product, amount_idr) VALUES ($1, $2, $3, $4)`, [
    orderId,
    user.id,
    product.code,
    product.priceIdr,
  ]);

  let snap: { token: string; redirect_url: string };
  try {
    snap = await createSnapTransaction(
      {
        transaction_details: { order_id: orderId, gross_amount: product.priceIdr },
        item_details: [{ id: product.code, price: product.priceIdr, quantity: 1, name: `ILMATRIX ${product.name}`.slice(0, 50) }],
        customer_details: {
          first_name: (user.name || "Siswa").slice(0, 50),
          ...(user.email ? { email: user.email } : {}),
        },
        callbacks: { finish: `${config.baseUrl}/payment.html` },
        ...(config.midtransEnabledPayments.length ? { enabled_payments: config.midtransEnabledPayments } : {}),
      },
      { notificationUrl: config.midtransNotificationUrl || undefined }
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[PAYMENT] Snap checkout failed for ${orderId}: ${reason}`);
    await query(`UPDATE payments SET status = 'failed', review_note = $2, updated_at = NOW() WHERE order_id = $1`, [
      orderId,
      `checkout failed: ${reason}`.slice(0, 500),
    ]);
    throw new PaymentError("PROVIDER_ERROR", 502, "Halaman pembayaran tidak bisa dibuka. Coba lagi sebentar lagi.");
  }

  await query(`UPDATE payments SET redirect_url = $2, snap_token = $3, updated_at = NOW() WHERE order_id = $1`, [
    orderId,
    snap.redirect_url,
    snap.token,
  ]);
  await recordEvent(orderId, "checkout", undefined, { redirect_url: snap.redirect_url });
  return { orderId, redirectUrl: snap.redirect_url, snapToken: snap.token, amountIdr: product.priceIdr, product, reused: false };
}

async function recordEvent(orderId: string, source: string, transactionStatus: string | undefined, payload: unknown, db: { query: typeof query } = { query }) {
  await db.query(`INSERT INTO payment_events (order_id, source, transaction_status, payload) VALUES ($1, $2, $3, $4)`, [
    orderId,
    source,
    transactionStatus ?? null,
    JSON.stringify(payload ?? null),
  ]);
}

/** Record a raw (signature-checked) notification for the audit trail. */
export async function recordNotification(orderId: string, notification: Record<string, unknown>): Promise<void> {
  await recordEvent(orderId, "notification", String(notification.transaction_status ?? ""), notification);
}

export async function getPayment(orderId: string): Promise<any | null> {
  const { rows } = await query(`SELECT * FROM payments WHERE order_id = $1`, [orderId]);
  return rows[0] ?? null;
}

/**
 * Ask Midtrans for the order's current status and apply it.
 * Throws MidtransError when Midtrans can't be reached (callers decide whether to retry).
 */
export async function syncPayment(orderId: string, source: "notification" | "status_check" | "admin"): Promise<any | null> {
  const status = await getTransactionStatus(orderId);
  if (!status) {
    // No transaction at Midtrans: the student never chose a method. Expire stale checkouts.
    await query(
      `UPDATE payments
       SET status = CASE WHEN status = 'pending' AND created_at < NOW() - make_interval(secs => $2) THEN 'expired' ELSE status END,
           last_checked_at = NOW(), updated_at = NOW()
       WHERE order_id = $1`,
      [orderId, PENDING_EXPIRY_MS / 1000]
    );
    return getPayment(orderId);
  }
  return applyStatus(orderId, status, source);
}

/** Apply an authoritative Midtrans status: update the payment and fulfil it once. */
export async function applyStatus(orderId: string, status: MidtransStatus, source: string): Promise<any | null> {
  return transaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM payments WHERE order_id = $1 FOR UPDATE`, [orderId]);
    const payment = rows[0];
    if (!payment) return null;

    // Status fetched from Midtrans (after a notification, a return-page poll, or by an admin)
    await recordEvent(orderId, source === "admin" ? "admin" : "status_check", status.transaction_status, status, client);

    if (status.order_id && status.order_id !== orderId) {
      throw new Error(`Midtrans status for ${status.order_id} returned for ${orderId}`);
    }

    // The amount must be exactly what we charged (and in rupiah)
    const amount = Number(status.gross_amount);
    if (!Number.isFinite(amount) || Math.round(amount) !== payment.amount_idr || (status.currency && status.currency !== "IDR")) {
      const note = `amount mismatch: Midtrans reports ${status.gross_amount} ${status.currency ?? ""}, expected ${payment.amount_idr} IDR`;
      console.error(`[PAYMENT] ${orderId}: ${note}`);
      const updated = await client.query(
        `UPDATE payments SET review_note = $2, provider_status = $3, last_checked_at = NOW(), updated_at = NOW()
         WHERE order_id = $1 RETURNING *`,
        [orderId, note, status.transaction_status ?? null]
      );
      return updated.rows[0];
    }

    let next = mapMidtransStatus(status.transaction_status, status.fraud_status);
    // Paid stays paid unless money goes back; refunded is final
    if (payment.status === "paid" && next !== "refunded") next = "paid";
    if (payment.status === "refunded") next = "refunded";

    let note: string | null = null;
    let fulfilNow = false;
    if (next === "paid" && !payment.fulfilled_at) {
      if (payment.user_id) {
        await fulfil(client, payment.user_id, payment.product, orderId);
        fulfilNow = true;
      } else {
        note = "paid after the account was deleted: nothing to fulfil";
      }
    }
    if (next === "refunded" && payment.status !== "refunded" && payment.fulfilled_at) {
      note = `${status.transaction_status} after fulfilment: plan/kredit was not revoked automatically`;
      console.warn(`[PAYMENT] ${orderId}: ${note}`);
    }

    const updated = await client.query(
      `UPDATE payments
       SET status = $2::text,
           provider_status = $3,
           fraud_status = $4,
           payment_type = COALESCE($5, payment_type),
           transaction_id = COALESCE($6, transaction_id),
           paid_at = CASE WHEN $2::text = 'paid' THEN COALESCE(paid_at, NOW()) ELSE paid_at END,
           fulfilled_at = CASE WHEN $7::boolean THEN NOW() ELSE fulfilled_at END,
           review_note = COALESCE($8::text, review_note),
           last_checked_at = NOW(),
           updated_at = NOW()
       WHERE order_id = $1
       RETURNING *`,
      [
        orderId,
        next,
        status.transaction_status ?? null,
        status.fraud_status ?? null,
        status.payment_type ?? null,
        status.transaction_id ?? null,
        fulfilNow,
        note,
      ]
    );
    if (fulfilNow) console.log(`[PAYMENT] ${orderId}: paid, ${payment.product} delivered`);
    return updated.rows[0];
  });
}

/** Deliver what was bought, inside the payment's transaction. */
async function fulfil(client: { query: typeof query }, userId: string, product: string, orderId: string): Promise<void> {
  if (isKreditProductCode(product)) {
    await grantProduct(userId, product, orderId, client);
    return;
  }
  if (isPlanCode(product) && product !== "free") {
    const { rows } = await client.query(`SELECT plan, plan_expires_at FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    const current = rows[0];
    let days = PLANS[product].durationDays ?? 30;
    // Checkout refuses a different active plan; if two checkouts raced, keep the remaining paid days
    if (current && current.plan !== "free" && current.plan !== product && current.plan_expires_at) {
      const remaining = new Date(current.plan_expires_at).getTime() - Date.now();
      if (remaining > 0) days += Math.ceil(remaining / DAY_MS);
    }
    await setPlan(userId, product, days, client);
    return;
  }
  throw new Error(`Unknown product ${product} on ${orderId}`);
}

function publicPayment(row: any) {
  const product = catalogItem(row.product);
  return {
    order_id: row.order_id,
    product: row.product,
    product_name: product?.name ?? row.product,
    amount_idr: row.amount_idr,
    status: row.status as PaymentStatus,
    payment_type: row.payment_type,
    created_at: row.created_at,
    paid_at: row.paid_at,
  };
}

/**
 * A user's payment, re-checked with Midtrans when it is still pending (the
 * return page polls this, so a missing webhook doesn't leave it pending).
 */
export async function getPaymentForUser(orderId: string, userId: string) {
  let row = (await query(`SELECT * FROM payments WHERE order_id = $1 AND user_id = $2`, [orderId, userId])).rows[0];
  if (!row) return null;
  const lastChecked = row.last_checked_at ? new Date(row.last_checked_at).getTime() : 0;
  if (row.status === "pending" && isPaymentsEnabled() && Date.now() - lastChecked > RECHECK_MS) {
    try {
      row = (await syncPayment(orderId, "status_check")) ?? row;
    } catch (error) {
      console.warn(`[PAYMENT] status check for ${orderId} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return publicPayment(row);
}

export async function listPaymentsForUser(userId: string, limit = 20) {
  const { rows } = await query(`SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`, [userId, limit]);
  return rows.map(publicPayment);
}

export async function listRecentPayments(limit = 50, status?: string) {
  const { rows } = await query(
    `SELECT p.order_id, p.product, p.amount_idr, p.status, p.provider_status, p.payment_type, p.review_note,
            p.created_at, p.paid_at, p.fulfilled_at, u.email AS user_email
     FROM payments p LEFT JOIN users u ON u.id = p.user_id
     WHERE ($2::text IS NULL OR p.status = $2)
     ORDER BY p.created_at DESC LIMIT $1`,
    [limit, status ?? null]
  );
  return rows;
}
