import type { Context, Next } from "hono";
import { getClientIp } from "../utils/security.js";
import config from "../config/env.js";

interface RateLimitBucket {
  tokens: number;
  resetAt: number;
}

/**
 * In-memory rate limiting using token bucket algorithm
 * For production, consider using Redis or similar distributed store
 */
class RateLimiter {
  private buckets = new Map<string, RateLimitBucket>();
  private readonly maxTokens: number;
  private readonly windowMs: number;

  constructor(
    maxTokens = config.rateLimitMax,
    windowMs = config.rateLimitWindowMs
  ) {
    this.maxTokens = maxTokens;
    this.windowMs = windowMs;

    // Clean up expired buckets periodically
    setInterval(() => this.cleanup(), this.windowMs);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets.entries()) {
      if (now >= bucket.resetAt) {
        this.buckets.delete(key);
      }
    }
  }

  /**
   * Check if request is allowed and consume a token if so
   */
  consume(clientId: string): { allowed: boolean; retryAfter?: number } {
    const now = Date.now();
    let bucket = this.buckets.get(clientId);

    // Create or reset bucket if expired
    if (!bucket || now >= bucket.resetAt) {
      bucket = {
        tokens: this.maxTokens,
        resetAt: now + this.windowMs,
      };
      this.buckets.set(clientId, bucket);
    }

    // Check if tokens available
    if (bucket.tokens <= 0) {
      return {
        allowed: false,
        retryAfter: Math.ceil((bucket.resetAt - now) / 1000),
      };
    }

    // Consume token
    bucket.tokens--;
    return { allowed: true };
  }

  /**
   * Get current status for a client
   */
  getStatus(clientId: string): { tokens: number; resetAt: number } {
    const bucket = this.buckets.get(clientId);
    if (!bucket) {
      return { tokens: this.maxTokens, resetAt: Date.now() + this.windowMs };
    }
    return { tokens: bucket.tokens, resetAt: bucket.resetAt };
  }
}

// Global rate limiter instance
const rateLimiter = new RateLimiter();

/**
 * Hono middleware for rate limiting
 */
export function rateLimitMiddleware() {
  return async (c: Context, next: Next) => {
    try {
      const clientIp = getClientIp(c);
      const result = rateLimiter.consume(clientIp);

      if (!result.allowed) {
        c.header("Retry-After", String(result.retryAfter || 60));
        c.header("X-RateLimit-Limit", String(config.rateLimitMax));
        c.header("X-RateLimit-Remaining", "0");
        c.header(
          "X-RateLimit-Reset",
          String(Math.floor(Date.now() / 1000) + (result.retryAfter || 60))
        );

        return c.json(
          {
            error: "Rate limit exceeded",
            retryAfter: result.retryAfter,
          },
          429
        );
      }

      // Add rate limit headers
      const status = rateLimiter.getStatus(clientIp);
      c.header("X-RateLimit-Limit", String(config.rateLimitMax));
      c.header("X-RateLimit-Remaining", String(status.tokens));
      c.header("X-RateLimit-Reset", String(Math.floor(status.resetAt / 1000)));
    } catch (error) {
      // Continue on rate limiting errors to avoid blocking requests
      console.warn("Rate limiting error:", error);
    }

    await next();
  };
}

export default rateLimiter;
