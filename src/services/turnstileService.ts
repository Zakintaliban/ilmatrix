import { randomUUID } from "node:crypto";
import config from "../config/env.js";

/**
 * Cloudflare Turnstile server-side validation.
 * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileResult {
  success: boolean;
  errorCodes: string[];
}

export type TurnstileVerifier = (params: {
  secret: string;
  token: string;
  remoteIp?: string;
  idempotencyKey: string;
}) => Promise<TurnstileResult>;

/** Calls Cloudflare's siteverify endpoint (5s timeout, fails closed). */
const cloudflareVerifier: TurnstileVerifier = async ({ secret, token, remoteIp, idempotencyKey }) => {
  const body = new URLSearchParams({ secret, response: token, idempotency_key: idempotencyKey });
  if (remoteIp && remoteIp !== "unknown") body.set("remoteip", remoteIp);

  try {
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body, signal: AbortSignal.timeout(5000) });
    const data: any = await res.json();
    return { success: data?.success === true, errorCodes: Array.isArray(data?.["error-codes"]) ? data["error-codes"] : [] };
  } catch (error) {
    console.error("[TURNSTILE] siteverify request failed:", error);
    return { success: false, errorCodes: ["siteverify-unreachable"] };
  }
};

let verifier: TurnstileVerifier = cloudflareVerifier;

/** Replace the verifier (tests). */
export function setTurnstileVerifier(fn: TurnstileVerifier | null): void {
  verifier = fn || cloudflareVerifier;
}

export function isTurnstileEnabled(): boolean {
  return !!(config.turnstileSiteKey && config.turnstileSecretKey);
}

export function getTurnstileSiteKey(): string {
  return config.turnstileSiteKey;
}

/** Validate a widget token once (tokens are single-use and expire after ~5 minutes). */
export async function verifyTurnstileToken(token: unknown, remoteIp?: string): Promise<TurnstileResult> {
  if (typeof token !== "string" || !token || token.length > 2048) {
    return { success: false, errorCodes: ["missing-input-response"] };
  }
  return verifier({
    secret: config.turnstileSecretKey,
    token,
    remoteIp,
    idempotencyKey: randomUUID(),
  });
}
