/**
 * Content-based abuse detection for AI requests
 * Detects suspicious patterns that indicate potential abuse
 */

interface AbusePattern {
  pattern: RegExp;
  severity: 'low' | 'medium' | 'high';
  description: string;
}

// Suspicious patterns that indicate potential abuse
const ABUSE_PATTERNS: AbusePattern[] = [
  {
    pattern: /^(yes|no|ok|test|a|1|\.)$/i,
    severity: 'medium',
    description: 'Single word/character responses'
  },
  {
    pattern: /^(.)\1{10,}$/,  // Same character repeated 10+ times
    severity: 'high',
    description: 'Repeated character spam'
  },
  {
    pattern: /^(.*?)\1{3,}$/,  // Same phrase repeated 3+ times
    severity: 'high', 
    description: 'Repeated phrase spam'
  },
  {
    pattern: /(.{1,10})\1{5,}/,  // Short patterns repeated 5+ times
    severity: 'medium',
    description: 'Pattern repetition'
  }
];

interface AbuseScore {
  score: number;
  reasons: string[];
  blocked: boolean;
}

/**
 * Analyze content for potential abuse patterns
 */
export function analyzeContentForAbuse(content: string): AbuseScore {
  const reasons: string[] = [];
  let score = 0;
  
  // Check length - very short content is suspicious for repeated requests
  if (content.trim().length < 5) {
    score += 2;
    reasons.push('Very short content');
  }
  
  // Check abuse patterns
  for (const { pattern, severity, description } of ABUSE_PATTERNS) {
    if (pattern.test(content)) {
      const points = severity === 'high' ? 5 : severity === 'medium' ? 3 : 1;
      score += points;
      reasons.push(description);
    }
  }
  
  // Check for excessive special characters
  const specialCharRatio = (content.match(/[^a-zA-Z0-9\s]/g) || []).length / content.length;
  if (specialCharRatio > 0.5) {
    score += 3;
    reasons.push('Excessive special characters');
  }
  
  // Block if score is too high
  const blocked = score >= 5;
  
  return { score, reasons, blocked };
}

/**
 * Track and detect repeated identical requests from same user
 */
class RequestDeduplication {
  private recentRequests = new Map<string, { content: string; timestamp: number; count: number }>();
  private readonly timeWindow = 5 * 60 * 1000; // 5 minutes
  private readonly maxDuplicates = 3; // Max identical requests in time window
  
  /**
   * Check if request is duplicate/spam
   */
  checkDuplicate(identifier: string, content: string): { isDuplicate: boolean; reason?: string } {
    const contentHash = this.hashContent(content);
    const key = `${identifier}:${contentHash}`;
    const now = Date.now();
    
    // Clean old entries
    this.cleanup();
    
    const existing = this.recentRequests.get(key);
    
    if (existing) {
      existing.count++;
      existing.timestamp = now;
      
      if (existing.count > this.maxDuplicates) {
        return { 
          isDuplicate: true, 
          reason: `Identical request repeated ${existing.count} times in ${this.timeWindow / 1000} seconds`
        };
      }
    } else {
      this.recentRequests.set(key, {
        content,
        timestamp: now,
        count: 1
      });
    }
    
    return { isDuplicate: false };
  }
  
  private hashContent(content: string): string {
    // Simple hash for content deduplication
    return content.toLowerCase().replace(/\s+/g, ' ').trim();
  }
  
  private cleanup(): void {
    const now = Date.now();
    const cutoff = now - this.timeWindow;
    
    for (const [key, entry] of this.recentRequests.entries()) {
      if (entry.timestamp < cutoff) {
        this.recentRequests.delete(key);
      }
    }
  }
}

// Global deduplication instance
const deduplication = new RequestDeduplication();

/**
 * Comprehensive abuse detection middleware
 */
export async function abuseDetectionMiddleware(c: Context, next: Next) {
  try {
    const body = await c.req.json().catch(() => ({}));
    const content = body.message || body.materialText || body.question || '';
    
    if (!content || typeof content !== 'string') {
      await next();
      return;
    }
    
    const clientIp = getClientIp(c);
    const user = c.get('user');
    const identifier = user?.id || `ip:${clientIp}`;
    
    // Content-based abuse detection
    const abuseAnalysis = analyzeContentForAbuse(content);
    if (abuseAnalysis.blocked) {
      console.log(`[ABUSE] Blocked request from ${identifier}: ${abuseAnalysis.reasons.join(', ')}`);
      return c.json({
        error: 'Request blocked due to suspicious content patterns',
        reasons: abuseAnalysis.reasons
      }, 400);
    }
    
    // Duplicate request detection
    const duplicationCheck = deduplication.checkDuplicate(identifier, content);
    if (duplicationCheck.isDuplicate) {
      console.log(`[ABUSE] Duplicate request from ${identifier}: ${duplicationCheck.reason}`);
      return c.json({
        error: 'Too many identical requests',
        reason: duplicationCheck.reason
      }, 429);
    }
    
    // Log suspicious but not blocked requests
    if (abuseAnalysis.score >= 3) {
      console.log(`[SUSPICIOUS] Request from ${identifier} (score: ${abuseAnalysis.score}): ${abuseAnalysis.reasons.join(', ')}`);
    }
    
    await next();
    
  } catch (error) {
    console.error('Abuse detection middleware error:', error);
    // Don't block request on middleware error
    await next();
  }
}

import type { Context, Next } from "hono";
import { getClientIp } from "../utils/security.js";