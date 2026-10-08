/**
 * Throttles password guessing (in memory, per instance).
 *
 * After 10 failed sign-ins for one email, or 30 from one IP, within 15 minutes,
 * further attempts are refused until the window ends. Refused attempts don't
 * run bcrypt, so guessing can't be used to burn CPU either. A successful
 * sign-in clears the email's count. Google sign-in is unaffected, so a locked
 * account's owner is never fully shut out.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_EMAIL = 10;
const MAX_FAILURES_PER_IP = 30;

interface Counter {
  failures: number;
  windowStart: number;
}

export type ThrottleDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

class LoginThrottle {
  private counters = new Map<string, Counter>();

  check(email: string, ip: string, now = Date.now()): ThrottleDecision {
    let retryAfter = 0;
    for (const [key, max] of this.keys(email, ip)) {
      const counter = this.live(key, now);
      if (counter && counter.failures >= max) {
        retryAfter = Math.max(retryAfter, Math.ceil((counter.windowStart + WINDOW_MS - now) / 1000));
      }
    }
    return retryAfter > 0 ? { allowed: false, retryAfterSeconds: retryAfter } : { allowed: true };
  }

  recordFailure(email: string, ip: string, now = Date.now()): void {
    for (const [key] of this.keys(email, ip)) {
      const counter = this.live(key, now) ?? { failures: 0, windowStart: now };
      counter.failures++;
      this.counters.set(key, counter);
    }
  }

  recordSuccess(email: string): void {
    this.counters.delete(`email:${normalize(email)}`);
  }

  /** Drop finished windows; returns how many were removed. */
  cleanup(now = Date.now()): number {
    let removed = 0;
    for (const [key, counter] of this.counters) {
      if (now - counter.windowStart >= WINDOW_MS) {
        this.counters.delete(key);
        removed++;
      }
    }
    return removed;
  }

  reset(): void {
    this.counters.clear();
  }

  private keys(email: string, ip: string): Array<[string, number]> {
    return [
      [`email:${normalize(email)}`, MAX_FAILURES_PER_EMAIL],
      [`ip:${ip}`, MAX_FAILURES_PER_IP],
    ];
  }

  private live(key: string, now: number): Counter | undefined {
    const counter = this.counters.get(key);
    if (counter && now - counter.windowStart >= WINDOW_MS) {
      this.counters.delete(key);
      return undefined;
    }
    return counter;
  }
}

function normalize(email: string): string {
  return String(email).trim().toLowerCase();
}

export const loginThrottle = new LoginThrottle();
