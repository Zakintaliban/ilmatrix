/**
 * Usage Controller
 * Handles token usage statistics and admin management endpoints
 */

import type { Context } from 'hono';
import * as tokenUsageService from '../services/tokenUsageService.js';

// ============================================================================
// User Endpoints (Authenticated Users)
// ============================================================================

/**
 * GET /api/usage/stats
 * Get current user's token usage statistics
 */
export async function getUserStats(c: Context) {
  try {
    const user = c.get('user');

    if (!user) {
      return c.json({ error: 'Not authenticated' }, 401);
    }

    const stats = await tokenUsageService.getUserUsageStats(user.id);

    return c.json({
      usage: {
        monthly: {
          used: stats.monthly_tokens_used,
          limit: stats.monthly_token_limit,
          remaining: stats.monthly_remaining,
          percentage: stats.monthly_percentage,
          resets_at: stats.monthly_usage_reset_at,
        },
        weekly: {
          used: stats.weekly_tokens_used,
          limit: stats.weekly_token_limit,
          remaining: stats.weekly_remaining,
          percentage: stats.weekly_percentage,
          resets_at: stats.weekly_usage_reset_at,
        },
        session: {
          id: stats.session_id,
          used: stats.session_tokens_used,
          limit: stats.session_token_limit,
          remaining: stats.session_remaining,
          percentage: stats.session_percentage,
          expires_at: stats.session_expires_at,
          time_remaining_minutes: stats.session_time_remaining_minutes,
        },
      },
      user: {
        id: stats.user_id,
        email: stats.email,
        name: stats.name,
        is_admin: stats.is_admin,
        token_access_enabled: stats.token_access_enabled,
      },
    });
  } catch (error) {
    console.error('Error getting user stats:', error);
    return c.json({ error: 'Failed to retrieve usage statistics' }, 500);
  }
}

/**
 * GET /api/usage/history
 * Get user's token usage history with pagination
 *
 * Query params:
 * - limit: number of records to return (default: 50, max: 100)
 * - offset: pagination offset (default: 0)
 */
export async function getUserHistory(c: Context) {
  try {
    const user = c.get('user');

    if (!user) {
      return c.json({ error: 'Not authenticated' }, 401);
    }

    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
    const offset = parseInt(c.req.query('offset') || '0');

    const history = await tokenUsageService.getUserUsageHistory(user.id, limit, offset);

    return c.json({
      history,
      pagination: {
        limit,
        offset,
        returned: history.length,
      },
    });
  } catch (error) {
    console.error('Error getting user history:', error);
    return c.json({ error: 'Failed to retrieve usage history' }, 500);
  }
}

/**
 * GET /api/usage/analytics
 * Get aggregated usage analytics for current user
 */
export async function getUserAnalytics(c: Context) {
  try {
    const user = c.get('user');

    if (!user) {
      return c.json({ error: 'Not authenticated' }, 401);
    }

    const analytics = await tokenUsageService.getUsageStats(user.id);

    return c.json({
      analytics: {
        today: analytics.today,
        this_week: analytics.this_week,
        this_month: analytics.this_month,
        total_all_time: analytics.total,
        by_endpoint: analytics.by_endpoint,
        by_model: analytics.by_model,
      },
    });
  } catch (error) {
    console.error('Error getting user analytics:', error);
    return c.json({ error: 'Failed to retrieve analytics' }, 500);
  }
}

// ============================================================================
// Admin Endpoints (Admin Users Only)
// ============================================================================

/**
 * Middleware to check if user is admin
 */
export async function requireAdmin(c: Context, next: () => Promise<void>) {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  // Check if user is admin in database
  const stats = await tokenUsageService.getUserUsageStats(user.id);

  if (!stats.is_admin) {
    return c.json({ error: 'Forbidden: Admin access required' }, 403);
  }

  await next();
}

/**
 * GET /api/admin/usage/dashboard
 * Get all users' token usage (admin only)
 *
 * Query params:
 * - limit: number of users to return (default: 100, max: 500)
 * - offset: pagination offset (default: 0)
 */
export async function getAdminDashboard(c: Context) {
  try {
    const limit = Math.min(parseInt(c.req.query('limit') || '100'), 500);
    const offset = parseInt(c.req.query('offset') || '0');

    const users = await tokenUsageService.getAllUsersUsage(limit, offset);

    // Calculate aggregate statistics
    const totalUsers = users.length;
    const totalTokensUsedWeekly = users.reduce((sum, u) => sum + u.weekly_tokens_used, 0);
    const totalTokensUsedMonthly = users.reduce((sum, u) => sum + u.monthly_tokens_used, 0);
    const usersAtWeeklyLimit = users.filter(u => u.weekly_percentage >= 100).length;
    const usersNearWeeklyLimit = users.filter(u => u.weekly_percentage >= 80 && u.weekly_percentage < 100).length;

    return c.json({
      users,
      aggregate: {
        total_users: totalUsers,
        total_tokens_used_weekly: totalTokensUsedWeekly,
        total_tokens_used_monthly: totalTokensUsedMonthly,
        users_at_weekly_limit: usersAtWeeklyLimit,
        users_near_weekly_limit: usersNearWeeklyLimit,
      },
      pagination: {
        limit,
        offset,
        returned: users.length,
      },
    });
  } catch (error) {
    console.error('Error getting admin dashboard:', error);
    return c.json({ error: 'Failed to retrieve admin dashboard' }, 500);
  }
}

/**
 * GET /api/admin/usage/user/:userId
 * Get detailed usage stats for a specific user (admin only)
 */
export async function getAdminUserDetail(c: Context) {
  try {
    const userId = c.req.param('userId');

    if (!userId) {
      return c.json({ error: 'User ID is required' }, 400);
    }

    const stats = await tokenUsageService.getUserUsageStats(userId);
    const history = await tokenUsageService.getUserUsageHistory(userId, 100);
    const analytics = await tokenUsageService.getUsageStats(userId);

    return c.json({
      user: {
        id: stats.user_id,
        email: stats.email,
        name: stats.name,
        is_admin: stats.is_admin,
        token_access_enabled: stats.token_access_enabled,
      },
      usage: {
        monthly: {
          used: stats.monthly_tokens_used,
          limit: stats.monthly_token_limit,
          remaining: stats.monthly_remaining,
          percentage: stats.monthly_percentage,
          resets_at: stats.monthly_usage_reset_at,
        },
        weekly: {
          used: stats.weekly_tokens_used,
          limit: stats.weekly_token_limit,
          remaining: stats.weekly_remaining,
          percentage: stats.weekly_percentage,
          resets_at: stats.weekly_usage_reset_at,
        },
        session: {
          id: stats.session_id,
          used: stats.session_tokens_used,
          limit: stats.session_token_limit,
          remaining: stats.session_remaining,
          percentage: stats.session_percentage,
          expires_at: stats.session_expires_at,
          time_remaining_minutes: stats.session_time_remaining_minutes,
        },
      },
      analytics,
      recent_history: history.slice(0, 20),
    });
  } catch (error) {
    console.error('Error getting admin user detail:', error);
    return c.json({ error: 'Failed to retrieve user details' }, 500);
  }
}

/**
 * POST /api/admin/usage/user/:userId/set-admin
 * Set user as admin (unlimited token access)
 *
 * Body:
 * - is_admin: boolean
 */
export async function setUserAdmin(c: Context) {
  try {
    const userId = c.req.param('userId');
    const body = await c.req.json();
    const { is_admin } = body;

    if (!userId) {
      return c.json({ error: 'User ID is required' }, 400);
    }

    if (typeof is_admin !== 'boolean') {
      return c.json({ error: 'is_admin must be a boolean' }, 400);
    }

    await tokenUsageService.setUserAdmin(userId, is_admin);

    return c.json({
      success: true,
      message: `User ${is_admin ? 'granted' : 'revoked'} admin access`,
    });
  } catch (error) {
    console.error('Error setting user admin:', error);
    return c.json({ error: 'Failed to update user admin status' }, 500);
  }
}

/**
 * POST /api/admin/usage/user/:userId/set-access
 * Enable or disable token access for a user
 *
 * Body:
 * - enabled: boolean
 */
export async function setUserTokenAccess(c: Context) {
  try {
    const userId = c.req.param('userId');
    const body = await c.req.json();
    const { enabled } = body;

    if (!userId) {
      return c.json({ error: 'User ID is required' }, 400);
    }

    if (typeof enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }

    await tokenUsageService.setTokenAccess(userId, enabled);

    return c.json({
      success: true,
      message: `Token access ${enabled ? 'enabled' : 'disabled'} for user`,
    });
  } catch (error) {
    console.error('Error setting token access:', error);
    return c.json({ error: 'Failed to update token access' }, 500);
  }
}

/**
 * POST /api/admin/usage/user/:userId/update-limits
 * Update user's token limits
 *
 * Body:
 * - weekly_limit?: number
 * - monthly_limit?: number
 */
export async function updateUserLimits(c: Context) {
  try {
    const userId = c.req.param('userId');
    const body = await c.req.json();
    const { weekly_limit, monthly_limit } = body;

    if (!userId) {
      return c.json({ error: 'User ID is required' }, 400);
    }

    if (weekly_limit !== undefined && (typeof weekly_limit !== 'number' || weekly_limit < 0)) {
      return c.json({ error: 'weekly_limit must be a positive number' }, 400);
    }

    if (monthly_limit !== undefined && (typeof monthly_limit !== 'number' || monthly_limit < 0)) {
      return c.json({ error: 'monthly_limit must be a positive number' }, 400);
    }

    await tokenUsageService.updateUserLimits({
      userId,
      weeklyLimit: weekly_limit,
      monthlyLimit: monthly_limit,
    });

    return c.json({
      success: true,
      message: 'User limits updated successfully',
      limits: {
        weekly_limit: weekly_limit || 'unchanged',
        monthly_limit: monthly_limit || 'unchanged',
      },
    });
  } catch (error) {
    console.error('Error updating user limits:', error);
    return c.json({ error: 'Failed to update user limits' }, 500);
  }
}

/**
 * POST /api/admin/usage/reset/weekly
 * Manually trigger weekly token reset for all users (admin only)
 */
export async function adminResetWeekly(c: Context) {
  try {
    const resetUserIds = await tokenUsageService.resetWeeklyUsage();

    return c.json({
      success: true,
      message: 'Weekly token usage reset completed',
      users_reset: resetUserIds.length,
      user_ids: resetUserIds,
    });
  } catch (error) {
    console.error('Error resetting weekly usage:', error);
    return c.json({ error: 'Failed to reset weekly usage' }, 500);
  }
}

/**
 * POST /api/admin/usage/reset/monthly
 * Manually trigger monthly token reset for all users (admin only)
 */
export async function adminResetMonthly(c: Context) {
  try {
    const resetUserIds = await tokenUsageService.resetMonthlyUsage();

    return c.json({
      success: true,
      message: 'Monthly token usage reset completed',
      users_reset: resetUserIds.length,
      user_ids: resetUserIds,
    });
  } catch (error) {
    console.error('Error resetting monthly usage:', error);
    return c.json({ error: 'Failed to reset monthly usage' }, 500);
  }
}

/**
 * POST /api/admin/usage/cleanup/sessions
 * Deactivate expired token usage sessions (admin only)
 */
export async function adminCleanupSessions(c: Context) {
  try {
    const deactivated = await tokenUsageService.deactivateExpiredSessions();

    return c.json({
      success: true,
      message: 'Expired sessions deactivated',
      sessions_deactivated: deactivated,
    });
  } catch (error) {
    console.error('Error cleaning up sessions:', error);
    return c.json({ error: 'Failed to cleanup sessions' }, 500);
  }
}

/**
 * POST /api/admin/usage/cleanup/logs
 * Clean up old token usage logs (older than 90 days) (admin only)
 */
export async function adminCleanupLogs(c: Context) {
  try {
    const deleted = await tokenUsageService.cleanupOldLogs();

    return c.json({
      success: true,
      message: 'Old logs cleaned up',
      logs_deleted: deleted,
    });
  } catch (error) {
    console.error('Error cleaning up logs:', error);
    return c.json({ error: 'Failed to cleanup logs' }, 500);
  }
}

/**
 * GET /api/admin/usage/export
 * Export all users' usage data as CSV (admin only)
 */
export async function exportUsageData(c: Context) {
  try {
    const users = await tokenUsageService.getAllUsersUsage(10000, 0); // Get up to 10k users

    // Generate CSV
    const csvHeader = 'User ID,Email,Name,Weekly Used,Weekly Limit,Weekly %,Monthly Used,Monthly Limit,Monthly %,Is Admin,Access Enabled\n';

    const csvRows = users.map(user => {
      return [
        user.user_id,
        user.email,
        user.name,
        user.weekly_tokens_used,
        user.weekly_token_limit,
        user.weekly_percentage.toFixed(2),
        user.monthly_tokens_used,
        user.monthly_token_limit,
        user.monthly_percentage.toFixed(2),
        user.is_admin,
        user.token_access_enabled,
      ].join(',');
    }).join('\n');

    const csv = csvHeader + csvRows;

    // Set headers for CSV download
    c.header('Content-Type', 'text/csv');
    c.header('Content-Disposition', `attachment; filename="token-usage-${new Date().toISOString().split('T')[0]}.csv"`);

    return c.body(csv);
  } catch (error) {
    console.error('Error exporting usage data:', error);
    return c.json({ error: 'Failed to export usage data' }, 500);
  }
}
