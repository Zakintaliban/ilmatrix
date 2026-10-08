import type { Context } from "hono";
import {
  PaymentError,
  createCheckout,
  getCatalog,
  getPayment,
  getPaymentForUser,
  isPaymentsEnabled,
  listPaymentsForUser,
  listRecentPayments,
  recordNotification,
  snapJsConfig,
  syncPayment,
} from "../services/paymentService.js";
import { verifyNotificationSignature } from "../services/midtransClient.js";

const ORDER_ID = /^[A-Za-z0-9\-_~.]{1,50}$/;

function paymentError(c: Context, error: unknown) {
  if (error instanceof PaymentError) {
    return c.json({ error: error.message, code: error.code }, error.httpStatus);
  }
  console.error("[PAYMENT] Unexpected error:", error);
  return c.json({ error: "Pembayaran gagal diproses. Coba lagi." }, 500);
}

/** GET /api/payments/products: what can be bought (public). */
export function getProducts(c: Context) {
  return c.json({
    enabled: isPaymentsEnabled(),
    products: getCatalog().map((p) => ({
      code: p.code,
      kind: p.kind,
      name: p.name,
      price_idr: p.priceIdr,
      description: p.description,
    })),
  });
}

/** POST /api/payments/checkout { product } (signed in): returns the Midtrans page URL. */
export async function checkout(c: Context) {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  try {
    const result = await createCheckout(user, body?.product);
    const snap = snapJsConfig();
    return c.json(
      {
        order_id: result.orderId,
        // Popup on our checkout page when Snap.js is configured; redirect_url is the fallback
        snap_token: result.snapToken,
        snap_js_url: snap && result.snapToken ? snap.url : null,
        client_key: snap && result.snapToken ? snap.clientKey : null,
        redirect_url: result.redirectUrl,
        amount_idr: result.amountIdr,
        product: result.product.code,
        reused: result.reused,
      },
      result.reused ? 200 : 201
    );
  } catch (error) {
    return paymentError(c, error);
  }
}

/** GET /api/payments/:orderId (signed in, own payments only). */
export async function getPaymentStatus(c: Context) {
  const orderId = c.req.param("orderId")!;
  if (!ORDER_ID.test(orderId)) return c.json({ error: "Pembayaran tidak ditemukan." }, 404);
  const payment = await getPaymentForUser(orderId, c.get("user").id);
  if (!payment) return c.json({ error: "Pembayaran tidak ditemukan." }, 404);
  return c.json({ payment });
}

/** GET /api/payments (signed in): payment history. */
export async function listMyPayments(c: Context) {
  return c.json({ payments: await listPaymentsForUser(c.get("user").id) });
}

/**
 * POST /api/payments/midtrans/notification (Midtrans webhook).
 * The signature proves the call is from Midtrans; the status is then fetched
 * from Midtrans' API (the signature doesn't cover transaction_status). A 503
 * makes Midtrans retry (4 times) when we can't confirm right now.
 */
export async function midtransNotification(c: Context) {
  if (!isPaymentsEnabled()) return c.json({ error: "Payments are not configured" }, 503);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || typeof body.order_id !== "string" || !ORDER_ID.test(body.order_id)) {
    return c.json({ error: "Invalid notification" }, 400);
  }
  if (!verifyNotificationSignature(body)) {
    console.warn(`[PAYMENT] Notification with an invalid signature for ${body.order_id}`);
    return c.json({ error: "Invalid signature" }, 403);
  }

  const payment = await getPayment(body.order_id);
  if (!payment) {
    // Genuine but not ours (e.g. the dashboard's test notification): acknowledge so it isn't retried
    return c.json({ ok: true, ignored: "unknown order" });
  }

  try {
    await recordNotification(body.order_id, body);
    await syncPayment(body.order_id, "notification");
  } catch (error) {
    console.error(`[PAYMENT] Could not process notification for ${body.order_id}:`, error instanceof Error ? error.message : error);
    return c.json({ error: "Temporarily unable to confirm the payment" }, 503);
  }
  return c.json({ ok: true });
}

/** GET /api/admin/payments?status=paid (admin). */
export async function adminListPayments(c: Context) {
  const status = c.req.query("status");
  const allowed = ["pending", "paid", "failed", "expired", "refunded"];
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 50));
  return c.json({ payments: await listRecentPayments(limit, status && allowed.includes(status) ? status : undefined) });
}

/** POST /api/admin/payments/:orderId/sync (admin): re-check with Midtrans now. */
export async function adminSyncPayment(c: Context) {
  const orderId = c.req.param("orderId")!;
  if (!ORDER_ID.test(orderId) || !(await getPayment(orderId))) return c.json({ error: "Payment not found" }, 404);
  try {
    const payment = await syncPayment(orderId, "admin");
    return c.json({ payment });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
  }
}
