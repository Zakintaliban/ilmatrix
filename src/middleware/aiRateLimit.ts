import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import config from "../config/env.js";
import { getClientIp } from "../utils/security.js";

/**
 * Rate limiting for AI endpoints, per user (guests: per device cookie, or per
 * IP without one).
 *
 * Kredit already bounds what a user can spend; this keeps one client from
 * flooding the shared Groq queue (GROQ_CONCURRENCY slots per process) and the
 * org-wide Groq rate limits that every student depends on:
 * - requests in flight (AI_MAX_CONCURRENT, default 2): extra requests are
 *   rejected instead of queueing behind everyone else
 * - sliding windows of AI_RATE_LIMIT_PER_MINUTE (12) and AI_RATE_LIMIT_PER_HOUR (150)
 *
 * Admitted requests count whether or not they succeed; rejected ones don't, so
 * a client retrying after a 429 is not locked out. In memory, per instance.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DEVICE_ID = /^[0-9a-f-]{36}$/i;

export type AILimitReason = "concurrency" | "minute" | "hour";

export type AIRateDecision =
  | { allowed: true }
  | { allowed: false; reason: AILimitReason; retryAfterSeconds: number };

interface Entry {
  /** Admission times within the last hour, oldest first */
  requests: number[];
  inFlight: number;
}

class AIRateLimiter {
  private entries = new Map<string, Entry>();

  /** Admit a request (counted and marked in flight) or say why not. */
  acquire(key: string, now = Date.now()): AIRateDecision {
    const entry = this.entries.get(key) ?? { requests: [], inFlight: 0 };
    this.prune(entry, now);

    if (entry.inFlight >= config.aiMaxConcurrent) {
      return { allowed: false, reason: "concurrency", retryAfterSeconds: 5 };
    }

    const { requests } = entry;
    let lastMinute = 0;
    for (let i = requests.length - 1; i >= 0 && requests[i] > now - MINUTE_MS; i--) lastMinute++;
    if (lastMinute >= config.aiRateLimitPerMinute) {
      // The request that has to leave the window before another fits
      const oldest = requests[requests.length - config.aiRateLimitPerMinute];
      return { allowed: false, reason: "minute", retryAfterSeconds: secondsUntil(oldest + MINUTE_MS, now) };
    }
    if (requests.length >= config.aiRateLimitPerHour) {
      const oldest = requests[requests.length - config.aiRateLimitPerHour];
      return { allowed: false, reason: "hour", retryAfterSeconds: secondsUntil(oldest + HOUR_MS, now) };
    }

    requests.push(now);
    entry.inFlight++;
    this.entries.set(key, entry);
    return { allowed: true };
  }

  /** Mark an admitted request as finished. */
  release(key: string): void {
    const entry = this.entries.get(key);
    if (entry && entry.inFlight > 0) entry.inFlight--;
  }

  /** Drop idle entries; returns how many were removed. */
  cleanup(now = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      this.prune(entry, now);
      if (entry.inFlight === 0 && entry.requests.length === 0) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  reset(): void {
    this.entries.clear();
  }

  private prune(entry: Entry, now: number): void {
    const cutoff = now - HOUR_MS;
    let drop = 0;
    while (drop < entry.requests.length && entry.requests[drop] <= cutoff) drop++;
    if (drop) entry.requests.splice(0, drop);
  }
}

function secondsUntil(time: number, now: number): number {
  return Math.max(1, Math.ceil((time - now) / 1000));
}

export const aiRateLimiter = new AIRateLimiter();

/** Who a request counts against: the user, else the guest device, else the IP. */
export function aiRateLimitKey(c: Context): string {
  const user = c.get("user");
  if (user?.id) return `user:${user.id}`;
  const deviceId = getCookie(c, "device_id");
  if (deviceId && DEVICE_ID.test(deviceId)) return `device:${deviceId}`;
  return `ip:${getClientIp(c)}`;
}

function limitMessage(reason: AILimitReason, retryAfterSeconds: number): string {
  if (reason === "concurrency") {
    return "Permintaan AI sebelumnya masih diproses. Tunggu sampai selesai, lalu coba lagi.";
  }
  const wait = retryAfterSeconds < 60 ? `${retryAfterSeconds} detik` : `${Math.ceil(retryAfterSeconds / 60)} menit`;
  return `Terlalu banyak permintaan AI dalam waktu singkat. Coba lagi dalam ${wait}.`;
}

/**
 * Protects AI endpoints. Runs after auth (so signed-in users are keyed by
 * account) and before the guest limit (so a rejected request doesn't use up a
 * guest's trial).
 */
export async function aiRateLimitMiddleware(c: Context, next: Next) {
  const key = aiRateLimitKey(c);
  const decision = aiRateLimiter.acquire(key);

  if (!decision.allowed) {
    const message = limitMessage(decision.reason, decision.retryAfterSeconds);
    c.header("Retry-After", String(decision.retryAfterSeconds));
    return c.json(
      {
        error: message,
        // Text tools render `answer`, so the student sees the reason in the chat
        answer: message,
        code: decision.reason === "concurrency" ? "AI_CONCURRENCY_LIMIT" : "AI_RATE_LIMITED",
        retryAfter: decision.retryAfterSeconds,
      },
      429
    );
  }

  // A streamed answer keeps its slot until the stream ends, not when the response starts
  let releaseLater = false;
  try {
    await next();
    const streamDone = c.get("streamDone") as Promise<void> | undefined;
    if (streamDone) {
      releaseLater = true;
      void streamDone.finally(() => aiRateLimiter.release(key));
    }
  } finally {
    if (!releaseLater) aiRateLimiter.release(key);
  }
}
