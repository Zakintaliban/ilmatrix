/**
 * Token Usage Service
 * Manages Claude Code-style token usage system with session, weekly, and monthly limits
 *
 * Rules:
 * - Monthly limit: 1M tokens (informational tracking)
 * - Weekly limit: 250k tokens (hard limit, resets weekly)
 * - Session limit: 25k tokens per 5 hours (counter resets every 5 hours)
 * - Tokens consumed from session count towards weekly/monthly totals
 * - Admin users have unlimited access
 */

import { query, transaction } from './databaseService.js';
import type { PoolClient } from 'pg';

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface TokenUsageSession {
  id: string;
  user_id: string;
  session_tokens_used: number;
  session_token_limit: number;
  session_started_at: Date;
  session_expires_at: Date;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface TokenUsageLog {
  id: string;
  user_id: string;
  session_id: string | null;
  tokens_used: number;
  endpoint: string;
  model_used: string | null;
  request_type: string;
  material_id: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  metadata: Record<string, any>;
  created_at: Date;
}

export interface UserTokenUsage {
  user_id: string;
  email: string;
  name: string;

  // Monthly tracking
  monthly_token_limit: number;
  monthly_tokens_used: number;
  monthly_usage_reset_at: Date;
  monthly_remaining: number;
  monthly_percentage: number;

  // Weekly tracking
  weekly_token_limit: number;
  weekly_tokens_used: number;
  weekly_usage_reset_at: Date;
  weekly_remaining: number;
  weekly_percentage: number;

  // Session tracking
  session_id: string | null;
  session_tokens_used: number;
  session_token_limit: number;
  session_remaining: number;
  session_percentage: number;
  session_expires_at: Date | null;
  session_time_remaining_minutes: number | null;

  // Flags
  is_admin: boolean;
  token_access_enabled: boolean;
}

export interface TokenCheckResult {
  allowed: boolean;
  reason: string;
  weekly_remaining: number;
  session_remaining: number;
  requires_new_session: boolean;
}

export interface TokenUpdateResult {
  success: boolean;
  new_weekly_used: number;
  new_monthly_used: number;
  new_session_used: number;
  weekly_remaining: number;
  session_remaining: number;
}

export interface UsageStats {
  today: number;
  this_week: number;
  this_month: number;
  total: number;
  by_endpoint: Record<string, number>;
  by_model: Record<string, number>;
}

// ============================================================================
// Session Management
// ============================================================================

/**
 * Get or create an active token usage session for a user
 * Sessions last 5 hours and have a 25k token limit
 */
export async function getOrCreateSession(userId: string): Promise<TokenUsageSession> {
  // Use the database function to get or create session
  const result = await query<{ session_id: string }>(
    'SELECT get_or_create_active_session($1) as session_id',
    [userId]
  );

  const sessionId = result.rows[0]?.session_id;

  if (!sessionId) {
    throw new Error('Failed to get or create session');
  }

  // Fetch the session details
  const sessionResult = await query<TokenUsageSession>(
    'SELECT * FROM token_usage_sessions WHERE id = $1',
    [sessionId]
  );

  if (sessionResult.rows.length === 0) {
    throw new Error('Session not found after creation');
  }

  return sessionResult.rows[0];
}

/**
 * Get current active session for a user (if exists)
 */
export async function getCurrentSession(userId: string): Promise<TokenUsageSession | null> {
  const result = await query<TokenUsageSession>(
    `SELECT * FROM token_usage_sessions
     WHERE user_id = $1
     AND is_active = TRUE
     AND session_expires_at > NOW()
     ORDER BY session_started_at DESC
     LIMIT 1`,
    [userId]
  );

  return result.rows[0] || null;
}

/**
 * Reset session counter if expired (5 hours passed)
 * This allows user to continue using tokens in a new 5-hour window
 */
export async function resetSessionIfExpired(sessionId: string): Promise<boolean> {
  const result = await query(
    `UPDATE token_usage_sessions
     SET session_tokens_used = 0,
         session_started_at = NOW(),
         session_expires_at = NOW() + INTERVAL '5 hours',
         updated_at = NOW()
     WHERE id = $1
     AND session_expires_at <= NOW()
     AND is_active = TRUE
     RETURNING id`,
    [sessionId]
  );

  return result.rowCount > 0;
}

/**
 * Deactivate expired sessions
 */
export async function deactivateExpiredSessions(): Promise<number> {
  const result = await query<{ deactivate_expired_sessions: number }>(
    'SELECT deactivate_expired_sessions() as count'
  );

  return result.rows[0]?.deactivate_expired_sessions || 0;
}

// ============================================================================
// Usage Checking and Validation
// ============================================================================

/**
 * Check if user can use the specified number of tokens
 * Returns detailed information about availability and limits
 */
export async function checkTokenAvailability(
  userId: string,
  tokensNeeded: number
): Promise<TokenCheckResult> {
  const result = await query<{
    can_use: boolean;
    reason: string;
    weekly_remaining: number;
    session_remaining: number;
  }>(
    'SELECT * FROM can_user_use_tokens($1, $2)',
    [userId, tokensNeeded]
  );

  const check = result.rows[0];

  if (!check) {
    return {
      allowed: false,
      reason: 'User not found',
      weekly_remaining: 0,
      session_remaining: 0,
      requires_new_session: false,
    };
  }

  return {
    allowed: check.can_use,
    reason: check.reason,
    weekly_remaining: check.weekly_remaining,
    session_remaining: check.session_remaining,
    requires_new_session: check.session_remaining === 0 && check.can_use,
  };
}

/**
 * Get comprehensive token usage statistics for a user
 */
export async function getUserUsageStats(userId: string): Promise<UserTokenUsage> {
  const result = await query<any>(
    `SELECT
      u.id as user_id,
      u.email,
      u.name,
      u.monthly_token_limit,
      u.monthly_tokens_used,
      u.monthly_usage_reset_at,
      u.weekly_token_limit,
      u.weekly_tokens_used,
      u.weekly_usage_reset_at,
      u.is_admin,
      u.token_access_enabled,
      s.id as session_id,
      COALESCE(s.session_tokens_used, 0) as session_tokens_used,
      COALESCE(s.session_token_limit, 25000) as session_token_limit,
      s.session_expires_at
     FROM users u
     LEFT JOIN LATERAL (
       SELECT * FROM token_usage_sessions
       WHERE user_id = u.id
       AND is_active = TRUE
       AND session_expires_at > NOW()
       ORDER BY session_started_at DESC
       LIMIT 1
     ) s ON true
     WHERE u.id = $1`,
    [userId]
  );

  const row = result.rows[0];

  if (!row) {
    throw new Error('User not found');
  }

  // Calculate remaining and percentages
  const monthlyRemaining = row.monthly_token_limit - row.monthly_tokens_used;
  const weeklyRemaining = row.weekly_token_limit - row.weekly_tokens_used;
  const sessionRemaining = row.session_token_limit - row.session_tokens_used;

  const monthlyPercentage = (row.monthly_tokens_used / row.monthly_token_limit) * 100;
  const weeklyPercentage = (row.weekly_tokens_used / row.weekly_token_limit) * 100;
  const sessionPercentage = (row.session_tokens_used / row.session_token_limit) * 100;

  // Calculate session time remaining
  let sessionTimeRemaining: number | null = null;
  if (row.session_expires_at) {
    const expiresAt = new Date(row.session_expires_at);
    const now = new Date();
    sessionTimeRemaining = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / (1000 * 60)));
  }

  return {
    user_id: row.user_id,
    email: row.email,
    name: row.name,

    monthly_token_limit: row.monthly_token_limit,
    monthly_tokens_used: row.monthly_tokens_used,
    monthly_usage_reset_at: row.monthly_usage_reset_at,
    monthly_remaining: monthlyRemaining,
    monthly_percentage: Math.round(monthlyPercentage * 100) / 100,

    weekly_token_limit: row.weekly_token_limit,
    weekly_tokens_used: row.weekly_tokens_used,
    weekly_usage_reset_at: row.weekly_usage_reset_at,
    weekly_remaining: weeklyRemaining,
    weekly_percentage: Math.round(weeklyPercentage * 100) / 100,

    session_id: row.session_id,
    session_tokens_used: row.session_tokens_used,
    session_token_limit: row.session_token_limit,
    session_remaining: sessionRemaining,
    session_percentage: Math.round(sessionPercentage * 100) / 100,
    session_expires_at: row.session_expires_at,
    session_time_remaining_minutes: sessionTimeRemaining,

    is_admin: row.is_admin,
    token_access_enabled: row.token_access_enabled,
  };
}

// ============================================================================
// Token Usage Updates
// ============================================================================

/**
 * Update user and session token usage atomically
 * This is the main function called after an AI request completes
 */
export async function updateTokenUsage(
  userId: string,
  sessionId: string,
  tokensUsed: number
): Promise<TokenUpdateResult> {
  const result = await query<{
    success: boolean;
    new_weekly_used: number;
    new_session_used: number;
  }>(
    'SELECT * FROM update_user_token_usage($1, $2, $3)',
    [userId, tokensUsed, sessionId]
  );

  const update = result.rows[0];

  if (!update || !update.success) {
    throw new Error('Failed to update token usage');
  }

  // Get fresh stats to calculate remaining
  const stats = await getUserUsageStats(userId);

  return {
    success: true,
    new_weekly_used: update.new_weekly_used,
    new_monthly_used: stats.monthly_tokens_used,
    new_session_used: update.new_session_used,
    weekly_remaining: stats.weekly_remaining,
    session_remaining: stats.session_remaining,
  };
}

/**
 * Log a token usage event with detailed metadata
 */
export async function logTokenUsage(params: {
  userId: string;
  sessionId: string | null;
  tokensUsed: number;
  endpoint: string;
  modelUsed?: string;
  requestType: string;
  materialId?: string;
  promptTokens?: number;
  completionTokens?: number;
  metadata?: Record<string, any>;
}): Promise<TokenUsageLog> {
  const {
    userId,
    sessionId,
    tokensUsed,
    endpoint,
    modelUsed = null,
    requestType,
    materialId = null,
    promptTokens = 0,
    completionTokens = 0,
    metadata = {},
  } = params;

  const result = await query<TokenUsageLog>(
    `INSERT INTO token_usage_logs (
      user_id,
      session_id,
      tokens_used,
      endpoint,
      model_used,
      request_type,
      material_id,
      prompt_tokens,
      completion_tokens,
      metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *`,
    [
      userId,
      sessionId,
      tokensUsed,
      endpoint,
      modelUsed,
      requestType,
      materialId,
      promptTokens,
      completionTokens,
      JSON.stringify(metadata),
    ]
  );

  return result.rows[0];
}

// ============================================================================
// Usage History and Analytics
// ============================================================================

/**
 * Get token usage history for a user with pagination
 */
export async function getUserUsageHistory(
  userId: string,
  limit: number = 50,
  offset: number = 0
): Promise<TokenUsageLog[]> {
  const result = await query<TokenUsageLog>(
    `SELECT * FROM token_usage_logs
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  return result.rows;
}

/**
 * Get aggregated usage statistics for a user
 */
export async function getUsageStats(userId: string): Promise<UsageStats> {
  // Today's usage
  const todayResult = await query<{ total: string }>(
    `SELECT COALESCE(SUM(tokens_used), 0) as total
     FROM token_usage_logs
     WHERE user_id = $1
     AND created_at >= CURRENT_DATE`,
    [userId]
  );

  // This week's usage
  const weekResult = await query<{ total: string }>(
    `SELECT COALESCE(SUM(tokens_used), 0) as total
     FROM token_usage_logs
     WHERE user_id = $1
     AND created_at >= DATE_TRUNC('week', CURRENT_DATE)`,
    [userId]
  );

  // This month's usage
  const monthResult = await query<{ total: string }>(
    `SELECT COALESCE(SUM(tokens_used), 0) as total
     FROM token_usage_logs
     WHERE user_id = $1
     AND created_at >= DATE_TRUNC('month', CURRENT_DATE)`,
    [userId]
  );

  // Total usage
  const totalResult = await query<{ total: string }>(
    `SELECT COALESCE(SUM(tokens_used), 0) as total
     FROM token_usage_logs
     WHERE user_id = $1`,
    [userId]
  );

  // By endpoint
  const endpointResult = await query<{ endpoint: string; total: string }>(
    `SELECT endpoint, COALESCE(SUM(tokens_used), 0) as total
     FROM token_usage_logs
     WHERE user_id = $1
     GROUP BY endpoint
     ORDER BY total DESC`,
    [userId]
  );

  // By model
  const modelResult = await query<{ model_used: string; total: string }>(
    `SELECT model_used, COALESCE(SUM(tokens_used), 0) as total
     FROM token_usage_logs
     WHERE user_id = $1
     AND model_used IS NOT NULL
     GROUP BY model_used
     ORDER BY total DESC`,
    [userId]
  );

  const byEndpoint: Record<string, number> = {};
  for (const row of endpointResult.rows) {
    byEndpoint[row.endpoint] = parseInt(row.total, 10);
  }

  const byModel: Record<string, number> = {};
  for (const row of modelResult.rows) {
    byModel[row.model_used] = parseInt(row.total, 10);
  }

  return {
    today: parseInt(todayResult.rows[0]?.total || '0', 10),
    this_week: parseInt(weekResult.rows[0]?.total || '0', 10),
    this_month: parseInt(monthResult.rows[0]?.total || '0', 10),
    total: parseInt(totalResult.rows[0]?.total || '0', 10),
    by_endpoint: byEndpoint,
    by_model: byModel,
  };
}

// ============================================================================
// Reset Functions
// ============================================================================

/**
 * Reset weekly token usage for users whose reset time has passed
 * Returns list of user IDs that were reset
 */
export async function resetWeeklyUsage(): Promise<string[]> {
  const result = await query<{ user_id: string }>(
    'SELECT * FROM reset_weekly_tokens()'
  );

  return result.rows.map(row => row.user_id);
}

/**
 * Reset monthly token usage for users whose reset time has passed
 * Returns list of user IDs that were reset
 */
export async function resetMonthlyUsage(): Promise<string[]> {
  const result = await query<{ user_id: string }>(
    'SELECT * FROM reset_monthly_tokens()'
  );

  return result.rows.map(row => row.user_id);
}

/**
 * Check and perform any needed resets for a specific user
 * This is called lazily when user makes a request
 */
export async function checkAndResetUserUsage(userId: string): Promise<void> {
  await query(
    `DO $$
     BEGIN
       -- Reset weekly if needed
       IF EXISTS (
         SELECT 1 FROM users
         WHERE id = $1
         AND weekly_usage_reset_at <= NOW()
       ) THEN
         PERFORM reset_weekly_tokens();
       END IF;

       -- Reset monthly if needed
       IF EXISTS (
         SELECT 1 FROM users
         WHERE id = $1
         AND monthly_usage_reset_at <= NOW()
       ) THEN
         PERFORM reset_monthly_tokens();
       END IF;
     END $$`,
    [userId]
  );
}

// ============================================================================
// Admin Functions
// ============================================================================

/**
 * Get all users' token usage (admin only)
 */
export async function getAllUsersUsage(
  limit: number = 100,
  offset: number = 0
): Promise<UserTokenUsage[]> {
  const result = await query<any>(
    `SELECT
      u.id as user_id,
      u.email,
      u.name,
      u.monthly_token_limit,
      u.monthly_tokens_used,
      u.monthly_usage_reset_at,
      u.weekly_token_limit,
      u.weekly_tokens_used,
      u.weekly_usage_reset_at,
      u.is_admin,
      u.token_access_enabled,
      s.id as session_id,
      COALESCE(s.session_tokens_used, 0) as session_tokens_used,
      COALESCE(s.session_token_limit, 25000) as session_token_limit,
      s.session_expires_at
     FROM users u
     LEFT JOIN LATERAL (
       SELECT * FROM token_usage_sessions
       WHERE user_id = u.id
       AND is_active = TRUE
       AND session_expires_at > NOW()
       ORDER BY session_started_at DESC
       LIMIT 1
     ) s ON true
     ORDER BY u.weekly_tokens_used DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return result.rows.map(row => {
    const monthlyRemaining = row.monthly_token_limit - row.monthly_tokens_used;
    const weeklyRemaining = row.weekly_token_limit - row.weekly_tokens_used;
    const sessionRemaining = row.session_token_limit - row.session_tokens_used;

    const monthlyPercentage = (row.monthly_tokens_used / row.monthly_token_limit) * 100;
    const weeklyPercentage = (row.weekly_tokens_used / row.weekly_token_limit) * 100;
    const sessionPercentage = (row.session_tokens_used / row.session_token_limit) * 100;

    let sessionTimeRemaining: number | null = null;
    if (row.session_expires_at) {
      const expiresAt = new Date(row.session_expires_at);
      const now = new Date();
      sessionTimeRemaining = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / (1000 * 60)));
    }

    return {
      user_id: row.user_id,
      email: row.email,
      name: row.name,

      monthly_token_limit: row.monthly_token_limit,
      monthly_tokens_used: row.monthly_tokens_used,
      monthly_usage_reset_at: row.monthly_usage_reset_at,
      monthly_remaining: monthlyRemaining,
      monthly_percentage: Math.round(monthlyPercentage * 100) / 100,

      weekly_token_limit: row.weekly_token_limit,
      weekly_tokens_used: row.weekly_tokens_used,
      weekly_usage_reset_at: row.weekly_usage_reset_at,
      weekly_remaining: weeklyRemaining,
      weekly_percentage: Math.round(weeklyPercentage * 100) / 100,

      session_id: row.session_id,
      session_tokens_used: row.session_tokens_used,
      session_token_limit: row.session_token_limit,
      session_remaining: sessionRemaining,
      session_percentage: Math.round(sessionPercentage * 100) / 100,
      session_expires_at: row.session_expires_at,
      session_time_remaining_minutes: sessionTimeRemaining,

      is_admin: row.is_admin,
      token_access_enabled: row.token_access_enabled,
    };
  });
}

/**
 * Set user as admin (unlimited token access)
 */
export async function setUserAdmin(userId: string, isAdmin: boolean): Promise<void> {
  await query(
    'UPDATE users SET is_admin = $1, updated_at = NOW() WHERE id = $2',
    [isAdmin, userId]
  );
}

/**
 * Enable or disable token access for a user
 */
export async function setTokenAccess(userId: string, enabled: boolean): Promise<void> {
  await query(
    'UPDATE users SET token_access_enabled = $1, updated_at = NOW() WHERE id = $2',
    [enabled, userId]
  );
}

/**
 * Update user token limits
 */
export async function updateUserLimits(params: {
  userId: string;
  weeklyLimit?: number;
  monthlyLimit?: number;
}): Promise<void> {
  const { userId, weeklyLimit, monthlyLimit } = params;

  const updates: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (weeklyLimit !== undefined) {
    updates.push(`weekly_token_limit = $${paramIndex++}`);
    values.push(weeklyLimit);
  }

  if (monthlyLimit !== undefined) {
    updates.push(`monthly_token_limit = $${paramIndex++}`);
    values.push(monthlyLimit);
  }

  if (updates.length === 0) {
    return;
  }

  updates.push('updated_at = NOW()');
  values.push(userId);

  await query(
    `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
    values
  );
}

// ============================================================================
// Cleanup Functions
// ============================================================================

/**
 * Clean up old token usage logs (older than 90 days)
 */
export async function cleanupOldLogs(): Promise<number> {
  const result = await query<{ cleanup_old_token_logs: number }>(
    'SELECT cleanup_old_token_logs() as count'
  );

  return result.rows[0]?.cleanup_old_token_logs || 0;
}
