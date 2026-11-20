import { createHash, timingSafeEqual } from "node:crypto";
import config from "../config/env.js";

/**
 * Minimal Midtrans client (Snap + Get Status), same endpoints and auth as the
 * official midtrans-client package: HTTP Basic with the server key as user.
 * https://docs.midtrans.com/reference/request-body-json-parameter
 * https://docs.midtrans.com/reference/get-transaction-status
 */

const SNAP_URL = { sandbox: "https://app.sandbox.midtrans.com/snap/v1", production: "https://app.midtrans.com/snap/v1" };
const CORE_URL = { sandbox: "https://api.sandbox.midtrans.com", production: "https://api.midtrans.com" };
const TIMEOUT_MS = 15_000;

export class MidtransError extends Error {
  constructor(message: string, public httpStatus?: number, public body?: unknown) {
    super(message);
    this.name = "MidtransError";
  }
}

export interface SnapTransactionRequest {
  transaction_details: { order_id: string; gross_amount: number };
  item_details: Array<{ id: string; price: number; quantity: number; name: string }>;
  customer_details?: { first_name?: string; email?: string };
  callbacks?: { finish?: string };
  enabled_payments?: string[];
}

/** Fields of a Get Status response / HTTP notification that we use. */
export interface MidtransStatus {
  status_code: string;
  transaction_status?: string;
  fraud_status?: string;
  order_id?: string;
  transaction_id?: string;
  gross_amount?: string;
  currency?: string;
  payment_type?: string;
  [key: string]: unknown;
}

function env(): "sandbox" | "production" {
  return config.midtransIsProduction ? "production" : "sandbox";
}

function authHeader(): string {
  return "Basic " + Buffer.from(`${config.midtransServerKey}:`).toString("base64");
}

async function request(url: string, init: RequestInit): Promise<{ status: number; body: any }> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: authHeader(),
        ...(init.headers as Record<string, string>),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new MidtransError(`Midtrans request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new MidtransError(`Midtrans returned non-JSON (HTTP ${res.status})`, res.status, text.slice(0, 200));
  }
  return { status: res.status, body };
}

/** Create a Snap transaction; returns the hosted payment page URL. */
export async function createSnapTransaction(
  params: SnapTransactionRequest,
  options: { notificationUrl?: string } = {}
): Promise<{ token: string; redirect_url: string }> {
  const headers: Record<string, string> = {};
  // Per-transaction webhook URL, replacing the dashboard setting
  if (options.notificationUrl) headers["X-Override-Notification"] = options.notificationUrl;

  const { status, body } = await request(`${SNAP_URL[env()]}/transactions`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });
  if (status >= 400 || typeof body?.token !== "string" || typeof body?.redirect_url !== "string") {
    const detail = Array.isArray(body?.error_messages) ? body.error_messages.join("; ") : `HTTP ${status}`;
    throw new MidtransError(`Snap transaction failed: ${detail}`, status, body);
  }
  return { token: body.token, redirect_url: body.redirect_url };
}

/**
 * Current status of an order. Returns null when Midtrans has no transaction for
 * it yet (the customer never picked a payment method).
 */
export async function getTransactionStatus(orderId: string): Promise<MidtransStatus | null> {
  const { status, body } = await request(`${CORE_URL[env()]}/v2/${encodeURIComponent(orderId)}/status`, { method: "GET" });
  // Errors come back as HTTP 200 with a status_code in the body; 407 = expired (still a valid status)
  const code = String(body?.status_code ?? status);
  if (code === "404") return null;
  if (status >= 400 || (Number(code) >= 400 && code !== "407")) {
    throw new MidtransError(`Get Status failed: ${body?.status_message ?? `HTTP ${status}`}`, status, body);
  }
  return body as MidtransStatus;
}

/**
 * Notification signature: SHA512(order_id + status_code + gross_amount + ServerKey),
 * over the values exactly as received (gross_amount like "9900.00").
 * https://docs.midtrans.com/docs/https-notification-webhooks
 */
export function verifyNotificationSignature(notification: Record<string, unknown>, serverKey = config.midtransServerKey): boolean {
  const { order_id, status_code, gross_amount, signature_key } = notification;
  if (![order_id, status_code, gross_amount, signature_key].every((v) => typeof v === "string") || !serverKey) {
    return false;
  }
  const expected = createHash("sha512")
    .update(`${order_id}${status_code}${gross_amount}${serverKey}`)
    .digest("hex");
  const received = String(signature_key).toLowerCase();
  return received.length === expected.length && timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}
