import type { Context, Next } from "hono";
import { getClientIp } from "../utils/security.js";

interface AIRateLimitBucket {
  requests: number;
  tokensUsed: number;
  lastRequest: number;
  resetAt: number;
}

/**
 * Enhanced rate limiting specifically for AI endpoints
 * Prevents token limit abuse and DDoS attacks
 */
class AIRateLimiter {
  private buckets = new Map<string, AIRateLimitBucket>();
  
  // Rate limits per user/IP per hour
  private readonly maxRequestsPerHour = 100;  // Max AI requests per hour
  private readonly maxTokensPerHour = 50000;  // Max tokens consumed per hour
  private readonly burstLimit = 10;           // Max requests per minute (burst protection)
  private readonly windowMs = 60 * 60 * 1000; // 1 hour
  private readonly burstWindowMs = 60 * 1000;  // 1 minute
  
  constructor() {
    // Cleanup expired buckets every hour
    setInterval(() => this.cleanup(), this.windowMs);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.resetAt < now) {
        this.buckets.delete(key);
      }
    }
  }

  private getBucket(identifier: string): AIRateLimitBucket {
    const now = Date.now();
    let bucket = this.buckets.get(identifier);
    
    if (!bucket || bucket.resetAt < now) {
      bucket = {
        requests: 0,
        tokensUsed: 0,
        lastRequest: now,
        resetAt: now + this.windowMs
      };
      this.buckets.set(identifier, bucket);
    }
    
    return bucket;
  }

  /**
   * Check if request is allowed (before AI call)
   */
  checkRequest(identifier: string): { allowed: boolean; error?: string } {
    const bucket = this.getBucket(identifier);
    const now = Date.now();
    
    // Check hourly limits
    if (bucket.requests >= this.maxRequestsPerHour) {
      return { 
        allowed: false, 
        error: `Request limit exceeded. Maximum ${this.maxRequestsPerHour} AI requests per hour.` 
      };
    }
    
    if (bucket.tokensUsed >= this.maxTokensPerHour) {
      return { 
        allowed: false, 
        error: `Token limit exceeded. Maximum ${this.maxTokensPerHour} tokens per hour.` 
      };
    }
    
    // Check burst protection (requests per minute)
    const recentRequests = this.getRecentRequestCount(identifier);
    if (recentRequests >= this.burstLimit) {
      return { 
        allowed: false, 
        error: `Too many requests. Maximum ${this.burstLimit} requests per minute.` 
      };
    }
    
    return { allowed: true };
  }

  /**
   * Record successful AI request with token usage
   */
  recordRequest(identifier: string, tokensUsed: number): void {
    const bucket = this.getBucket(identifier);
    bucket.requests++;
    bucket.tokensUsed += tokensUsed;
    bucket.lastRequest = Date.now();
  }

  /**
   * Get recent request count for burst protection
   */
  private getRecentRequestCount(identifier: string): number {
    const bucket = this.buckets.get(identifier);
    if (!bucket) return 0;
    
    const now = Date.now();
    const minuteAgo = now - this.burstWindowMs;
    
    // For simplicity, approximate recent requests
    // In production, you'd want more precise tracking
    if (bucket.lastRequest > minuteAgo) {
      return Math.min(bucket.requests, this.burstLimit);
    }
    
    return 0;
  }

  /**
   * Get current limits for user
   */
  getCurrentLimits(identifier: string): {
    requestsRemaining: number;
    tokensRemaining: number;
    resetAt: number;
  } {
    const bucket = this.getBucket(identifier);
    return {
      requestsRemaining: Math.max(0, this.maxRequestsPerHour - bucket.requests),
      tokensRemaining: Math.max(0, this.maxTokensPerHour - bucket.tokensUsed),
      resetAt: bucket.resetAt
    };
  }
}

// Global AI rate limiter instance
const aiRateLimiter = new AIRateLimiter();

/**
 * Middleware to protect AI endpoints from abuse
 */
export async function aiRateLimitMiddleware(c: Context, next: Next) {
  try {
    const clientIp = getClientIp(c);
    const user = c.get('user');
    
    // Use user ID if authenticated, otherwise IP
    const identifier = user?.id || `ip:${clientIp}`;
    
    // Check if request is allowed
    const { allowed, error } = aiRateLimiter.checkRequest(identifier);
    
    if (!allowed) {
      const limits = aiRateLimiter.getCurrentLimits(identifier);
      return c.json({ 
        error,
        limits: {
          requestsRemaining: limits.requestsRemaining,
          tokensRemaining: limits.tokensRemaining,
          resetAt: new Date(limits.resetAt).toISOString()
        }
      }, 429);
    }
    
    // Store identifier for post-request recording
    c.set('aiRateLimitId', identifier);
    
    await next();
    
  } catch (error) {
    console.error('AI rate limit middleware error:', error);
    // Don't block request on middleware error
    await next();
  }
}

/**
 * Record token usage after AI request completes
 */
export function recordAITokenUsage(c: Context, tokensUsed: number): void {
  const identifier = c.get('aiRateLimitId');
  if (identifier) {
    aiRateLimiter.recordRequest(identifier, tokensUsed);
  }
}

export { aiRateLimiter };