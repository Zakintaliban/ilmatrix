import config from "../config/env.js";

/**
 * Per-IP daily caps for guests (in memory, 24-hour windows).
 *
 * The per-device limit alone is bypassed by discarding the device cookie;
 * these caps bound what one network can take without an account. They are
 * deliberately generous: many students share an IP (campus Wi-Fi, carrier
 * CGNAT), and hitting a cap only asks them to sign up for free.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;

interface Counter {
  windowStart: number;
  verifications: number;
  requests: number;
}

class GuestIpLimiter {
  private counters = new Map<string, Counter>();

  private counter(ip: string): Counter {
    const now = Date.now();
    let counter = this.counters.get(ip);
    if (!counter || now - counter.windowStart >= WINDOW_MS) {
      counter = { windowStart: now, verifications: 0, requests: 0 };
      this.counters.set(ip, counter);
    }
    return counter;
  }

  canVerify(ip: string): boolean {
    return this.counter(ip).verifications < config.guestIpDailyVerifications;
  }

  recordVerification(ip: string): void {
    this.counter(ip).verifications++;
  }

  canRequest(ip: string): boolean {
    return this.counter(ip).requests < config.guestIpDailyRequests;
  }

  recordRequest(ip: string): void {
    this.counter(ip).requests++;
  }

  /** Drop expired windows; returns how many were removed. */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [ip, counter] of this.counters) {
      if (now - counter.windowStart >= WINDOW_MS) {
        this.counters.delete(ip);
        removed++;
      }
    }
    return removed;
  }

  reset(): void {
    this.counters.clear();
  }
}

export const guestIpLimiter = new GuestIpLimiter();
