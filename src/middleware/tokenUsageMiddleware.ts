/**
 * Token Usage Middleware
 * Enforces Claude Code-style token limits for registered users
 *
 * Flow:
 * 1. Pre-request: Check if user has tokens available (weekly + session limits)
 * 2. Create/get active session
 * 3. Store session ID in context for controllers to use
 * 4. After request: Controllers are responsible for updating usage via tokenUsageService
 */

import type { Context, Next } from 'hono';
import * as tokenUsageService from '../services/tokenUsageService.js';

/**
 * Estimated tokens needed for different request types
 * Used for pre-flight checks before knowing actual usage
 */
const ESTIMATED_TOKENS = {
  explain: 3000,
  quiz: 5000,
  chat: 2000,
  flashcards: 4000,
  dialogue: 3000,
  exam: 5000,
  forum: 3000,
  default: 2000,
};

/**
 * Extract request type from endpoint path
 */
function getRequestType(path: string): string {
  if (path.includes('/explain')) return 'explain';
  if (path.includes('/quiz')) return 'quiz';
  if (path.includes('/chat')) return 'chat';
  if (path.includes('/flashcards')) return 'flashcards';
  if (path.includes('/dialogue')) return 'dialogue';
  if (path.includes('/exam')) return 'exam';
  if (path.includes('/forum')) return 'forum';
  return 'default';
}

/**
 * Get estimated tokens for a request type
 */
function getEstimatedTokens(requestType: string): number {
  return ESTIMATED_TOKENS[requestType as keyof typeof ESTIMATED_TOKENS] || ESTIMATED_TOKENS.default;
}

/**
 * Main token usage middleware for AI endpoints
 * Only applies to authenticated users (registered users)
 */
export async function tokenUsageMiddleware(c: Context, next: Next) {
  try {
    // Get user from context (set by authMiddleware or optionalAuthMiddleware)
    const user = c.get('user');

    // Skip token check for unauthenticated users (guest users)
    // Guest users are handled separately by guestLimitMiddleware
    if (!user) {
      await next();
      return;
    }

    const userId = user.id;
    const requestPath = c.req.path;
    const requestType = getRequestType(requestPath);
    const estimatedTokens = getEstimatedTokens(requestType);

    // Check and reset usage if needed (lazy reset on request)
    await tokenUsageService.checkAndResetUserUsage(userId);

    // Check token availability
    const availability = await tokenUsageService.checkTokenAvailability(userId, estimatedTokens);

    if (!availability.allowed) {
      // Get full stats for detailed error message
      const stats = await tokenUsageService.getUserUsageStats(userId);

      // Determine which limit was hit
      let errorMessage = 'Token limit exceeded';
      let resetTime: Date | null = null;

      if (availability.reason.includes('Weekly')) {
        errorMessage = `Weekly token limit reached. You've used ${stats.weekly_tokens_used.toLocaleString()} of ${stats.weekly_token_limit.toLocaleString()} tokens this week.`;
        resetTime = stats.weekly_usage_reset_at;
      } else if (availability.reason.includes('Session')) {
        errorMessage = `Session token limit reached. You've used ${stats.session_tokens_used.toLocaleString()} of ${stats.session_token_limit.toLocaleString()} tokens in this session.`;
        resetTime = stats.session_expires_at;
      } else if (availability.reason.includes('disabled')) {
        errorMessage = 'Token access has been disabled for your account. Please contact support.';
      }

      return c.json(
        {
          error: errorMessage,
          reason: availability.reason,
          usage: {
            weekly: {
              used: stats.weekly_tokens_used,
              limit: stats.weekly_token_limit,
              remaining: stats.weekly_remaining,
              percentage: stats.weekly_percentage,
              resets_at: stats.weekly_usage_reset_at,
            },
            session: {
              used: stats.session_tokens_used,
              limit: stats.session_token_limit,
              remaining: stats.session_remaining,
              percentage: stats.session_percentage,
              expires_at: stats.session_expires_at,
              time_remaining_minutes: stats.session_time_remaining_minutes,
            },
            monthly: {
              used: stats.monthly_tokens_used,
              limit: stats.monthly_token_limit,
              remaining: stats.monthly_remaining,
              percentage: stats.monthly_percentage,
            },
          },
          reset_time: resetTime,
        },
        429 // Too Many Requests
      );
    }

    // Get or create active session
    const session = await tokenUsageService.getOrCreateSession(userId);

    // Store session and user info in context for controllers to use
    c.set('tokenUsageSession', session);
    c.set('tokenUsageEstimate', estimatedTokens);
    c.set('requestType', requestType);

    // Proceed with request
    await next();

    // Note: Token usage update happens in the controller/service after getting actual usage from Groq
    // This is because we don't know exact token count until Groq responds

  } catch (error) {
    console.error('Token usage middleware error:', error);
    // Don't block request on middleware error - fail open for better UX
    // Admin users also bypass on error
    await next();
  }
}

/**
 * Helper function to update token usage after AI request
 * Call this from controllers after getting Groq response
 *
 * @param c - Hono context
 * @param tokensUsed - Actual tokens consumed (from Groq response)
 * @param metadata - Additional metadata to log (optional)
 * @returns Updated usage stats with warnings if needed
 */
export async function updateTokenUsageAfterRequest(
  c: Context,
  tokensUsed: number,
  metadata: Record<string, any> = {}
): Promise<{
  success: boolean;
  usage: tokenUsageService.TokenUpdateResult;
  warning?: string;
  notification?: 'low' | 'critical' | 'exceeded';
}> {
  try {
    const user = c.get('user');
    if (!user) {
      // No user, skip tracking (guest user)
      return {
        success: false,
        usage: {
          success: false,
          new_weekly_used: 0,
          new_monthly_used: 0,
          new_session_used: 0,
          weekly_remaining: 0,
          session_remaining: 0,
        },
      };
    }

    const session = c.get('tokenUsageSession');
    const requestType = c.get('requestType') || 'unknown';
    const endpoint = c.req.path;

    if (!session) {
      console.error('No token usage session found in context');
      return {
        success: false,
        usage: {
          success: false,
          new_weekly_used: 0,
          new_monthly_used: 0,
          new_session_used: 0,
          weekly_remaining: 0,
          session_remaining: 0,
        },
      };
    }

    // Update usage in database
    const usage = await tokenUsageService.updateTokenUsage(user.id, session.id, tokensUsed);

    // Log detailed usage
    await tokenUsageService.logTokenUsage({
      userId: user.id,
      sessionId: session.id,
      tokensUsed,
      endpoint,
      requestType,
      metadata,
    });

    // Calculate usage percentage to determine warnings
    const stats = await tokenUsageService.getUserUsageStats(user.id);
    const weeklyPercentage = stats.weekly_percentage;

    let warning: string | undefined;
    let notification: 'low' | 'critical' | 'exceeded' | undefined;

    if (weeklyPercentage >= 100) {
      warning = 'Weekly token limit reached. Please wait for reset.';
      notification = 'exceeded';
    } else if (weeklyPercentage >= 90) {
      warning = `You've used ${weeklyPercentage.toFixed(1)}% of your weekly token limit. Only ${stats.weekly_remaining.toLocaleString()} tokens remaining.`;
      notification = 'critical';
    } else if (weeklyPercentage >= 80) {
      warning = `You've used ${weeklyPercentage.toFixed(1)}% of your weekly token limit.`;
      notification = 'low';
    }

    // Add usage headers to response
    c.header('X-Token-Usage', tokensUsed.toString());
    c.header('X-Token-Weekly-Used', stats.weekly_tokens_used.toString());
    c.header('X-Token-Weekly-Remaining', stats.weekly_remaining.toString());
    c.header('X-Token-Session-Used', stats.session_tokens_used.toString());
    c.header('X-Token-Session-Remaining', stats.session_remaining.toString());
    c.header('X-Token-Weekly-Percentage', weeklyPercentage.toFixed(2));

    if (notification) {
      c.header('X-Token-Warning', notification);
    }

    return {
      success: true,
      usage,
      warning,
      notification,
    };
  } catch (error) {
    console.error('Error updating token usage:', error);
    return {
      success: false,
      usage: {
        success: false,
        new_weekly_used: 0,
        new_monthly_used: 0,
        new_session_used: 0,
        weekly_remaining: 0,
        session_remaining: 0,
      },
    };
  }
}

/**
 * Middleware that adds token usage stats to response for authenticated users
 * Use this on any endpoint to include usage stats in response
 */
export async function injectUsageStatsMiddleware(c: Context, next: Next) {
  await next();

  try {
    const user = c.get('user');
    if (!user) return;

    const stats = await tokenUsageService.getUserUsageStats(user.id);

    // Add usage stats to response headers
    c.header('X-Token-Weekly-Used', stats.weekly_tokens_used.toString());
    c.header('X-Token-Weekly-Remaining', stats.weekly_remaining.toString());
    c.header('X-Token-Weekly-Percentage', stats.weekly_percentage.toFixed(2));
    c.header('X-Token-Session-Remaining', stats.session_remaining.toString());
    c.header('X-Token-Session-Expires-In', (stats.session_time_remaining_minutes || 0).toString());
  } catch (error) {
    console.error('Error injecting usage stats:', error);
    // Don't fail the request
  }
}
