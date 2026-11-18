/**
 * Usage Controller
 * AI quota status, usage statistics and admin management endpoints
 */

import type { Context } from 'hono';
import * as tokenUsageService from '../services/tokenUsageService.js';
import * as kreditService from '../services/kreditService.js';
import config from '../config/env.js';
import { query } from '../services/databaseService.js';
import * as quotaService from '../services/quotaService.js';
import { reservationTable } from '../services/quotaEstimates.js';
import { isPaymentsEnabled } from '../services/paymentService.js';
import { KREDIT_PRODUCTS, isKreditProductCode, isPlanCode } from '../config/plans.js';

/** A quota limit from an admin: kredit (0 blocks AI) or null for the default. */
function isLimitValue(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000);
}

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

    const status = await quotaService.getStatus(user.id);

    return c.json({
      usage: quotaService.quotaSummary(status),
      recent_days: await quotaService.recentDays(user.id, 14),
      // Kredit reserved per request with default settings (what one use can cost at most, normally)
      tool_estimates: reservationTable(),
      payments_enabled: isPaymentsEnabled(),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        is_admin: status.exempt,
        token_access_enabled: status.accessEnabled,
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

  // The user is loaded from the database on every request (getUserBySessionToken)
  if (!user.is_admin) {
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
    const sum = (pick: (u: (typeof users)[number]) => number) => Math.round(users.reduce((n, u) => n + pick(u), 0) * 100) / 100;
    const peak = (u: (typeof users)[number]) => Math.max(u.daily_percentage, u.weekly_percentage);
    const defaults = await quotaService.getDefaults();

    return c.json({
      users,
      aggregate: {
        total_users: users.length,
        total_kredit_used_today: sum((u) => u.daily_kredit_used),
        total_kredit_used_weekly: sum((u) => u.weekly_kredit_used),
        total_kredit_used_monthly: sum((u) => u.monthly_kredit_used),
        users_at_daily_limit: users.filter((u) => !u.is_admin && u.daily_percentage >= 100).length,
        users_at_weekly_limit: users.filter((u) => !u.is_admin && u.weekly_percentage >= 100).length,
        users_at_limit: users.filter((u) => !u.is_admin && peak(u) >= 100).length,
        users_near_limit: users.filter((u) => !u.is_admin && peak(u) >= 80 && peak(u) < 100).length,
      },
      quota_defaults: {
        daily: defaults.daily,
        weekly: defaults.weekly,
        timezone: config.aiQuotaTimezone,
      },
      payments_enabled: isPaymentsEnabled(),
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
    const status = await quotaService.getStatus(userId);
    const history = await tokenUsageService.getUserUsageHistory(userId, 100);
    const analytics = await tokenUsageService.getUsageStats(userId);
    const overrides = await query(`SELECT daily_kredit_override, weekly_kredit_override FROM users WHERE id = $1`, [userId]);
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

    return c.json({
      user: {
        id: stats.user_id,
        email: stats.email,
        name: stats.name,
        is_admin: status.exempt,
        token_access_enabled: status.accessEnabled,
      },
      usage: quotaService.quotaSummary(status),
      overrides: {
        daily: num(overrides.rows[0]?.daily_kredit_override),
        weekly: num(overrides.rows[0]?.weekly_kredit_override),
      },
      recent_days: await quotaService.recentDays(userId, 14),
      payments_enabled: isPaymentsEnabled(),
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
 * Override a user's daily and/or weekly AI quota. This is the only way to
 * give one user more (or less) than the default; there is no hidden bypass.
 *
 * Body (each optional, at least one):
 * - daily_limit: number of kredit, or null for the global default
 * - weekly_limit: number of kredit, or null for the global default
 */
export async function updateUserLimits(c: Context) {
  try {
    const userId = c.req.param('userId')!;
    const body = await c.req.json().catch(() => ({}));
    const { daily_limit, weekly_limit } = body ?? {};

    if (daily_limit === undefined && weekly_limit === undefined) {
      return c.json({ error: 'Send daily_limit and/or weekly_limit' }, 400);
    }
    for (const [name, value] of [['daily_limit', daily_limit], ['weekly_limit', weekly_limit]] as const) {
      if (value !== undefined && !isLimitValue(value)) {
        return c.json({ error: `${name} must be a number of kredit between 0 and 1000000, or null for the default` }, 400);
      }
    }

    await quotaService.setUserLimits(userId, { daily: daily_limit, weekly: weekly_limit });
    const status = await quotaService.getStatus(userId);

    return c.json({ success: true, message: 'User limits updated successfully', usage: quotaService.quotaSummary(status) });
  } catch (error) {
    console.error('Error updating user limits:', error);
    return c.json({ error: 'Failed to update user limits' }, 500);
  }
}

/**
 * POST /api/admin/usage/user/:userId/reset-quota
 * Set the user's usage for today and/or this week back to zero.
 *
 * Body: { period: 'daily' | 'weekly' | 'both' }
 */
export async function resetUserQuota(c: Context) {
  try {
    const userId = c.req.param('userId')!;
    const { period } = await c.req.json().catch(() => ({}));
    const periods: quotaService.QuotaPeriod[] | undefined =
      period === 'daily' ? ['daily'] : period === 'weekly' ? ['weekly'] : period === 'both' ? ['daily', 'weekly'] : undefined;
    if (!periods) return c.json({ error: "period must be 'daily', 'weekly' or 'both'" }, 400);

    const status = await quotaService.resetUsage(userId, periods);
    return c.json({ success: true, usage: quotaService.quotaSummary(status) });
  } catch (error) {
    console.error('Error resetting user quota:', error);
    return c.json({ error: 'Failed to reset quota' }, 500);
  }
}

/** GET /api/admin/quota/settings: global daily/weekly defaults. */
export async function getQuotaSettings(c: Context) {
  try {
    const d = await quotaService.getDefaults();
    return c.json({
      daily_limit: d.daily,
      weekly_limit: d.weekly,
      daily_source: d.dailySource,
      weekly_source: d.weeklySource,
      env_defaults: { daily_limit: config.aiDailyKreditLimit, weekly_limit: config.aiWeeklyKreditLimit },
      timezone: config.aiQuotaTimezone,
      updated_at: d.updatedAt,
      tool_estimates: reservationTable(),
    });
  } catch (error) {
    console.error('Error reading quota settings:', error);
    return c.json({ error: 'Failed to read quota settings' }, 500);
  }
}

/**
 * PUT /api/admin/quota/settings
 * Body: { daily_limit?: number | null, weekly_limit?: number | null } (null = env default)
 */
export async function updateQuotaSettings(c: Context) {
  try {
    const { daily_limit, weekly_limit } = (await c.req.json().catch(() => ({}))) ?? {};
    if (daily_limit === undefined && weekly_limit === undefined) {
      return c.json({ error: 'Send daily_limit and/or weekly_limit' }, 400);
    }
    for (const [name, value] of [['daily_limit', daily_limit], ['weekly_limit', weekly_limit]] as const) {
      if (value !== undefined && !isLimitValue(value)) {
        return c.json({ error: `${name} must be a number of kredit between 0 and 1000000, or null for the env default` }, 400);
      }
    }
    await quotaService.setDefaults({ daily: daily_limit, weekly: weekly_limit }, c.get('user').id);
    return getQuotaSettings(c);
  } catch (error) {
    console.error('Error updating quota settings:', error);
    return c.json({ error: 'Failed to update quota settings' }, 500);
  }
}

/**
 * POST /api/admin/usage/user/:userId/set-plan
 * Put a user on a plan (payments enabled only; a paid plan sets the weekly quota)
 *
 * Body:
 * - plan: 'free' | 'bulanan' | 'semester'
 * - days?: number (default: the plan's duration; extends an active period)
 */
export async function setUserPlan(c: Context) {
  try {
    const userId = c.req.param('userId')!;
    const { plan, days } = await c.req.json();

    if (!isPlanCode(plan)) {
      return c.json({ error: 'plan must be one of: free, bulanan, semester' }, 400);
    }
    if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 400)) {
      return c.json({ error: 'days must be an integer between 1 and 400' }, 400);
    }

    await kreditService.setPlan(userId, plan, days);
    const status = await quotaService.getStatus(userId);
    return c.json({ success: true, usage: quotaService.quotaSummary(status) });
  } catch (error) {
    console.error('Error setting user plan:', error);
    return c.json({ error: 'Failed to set plan' }, 500);
  }
}

/**
 * POST /api/admin/usage/user/:userId/grant-kredit
 * Grant a product (pass_7d, topup) or a custom amount of kredit
 *
 * Body:
 * - product?: 'pass_7d' | 'topup'
 * - kredit?: number and valid_days?: number | null (custom grant)
 * - reference?: string (e.g. payment reference)
 */
export async function grantUserKredit(c: Context) {
  try {
    const userId = c.req.param('userId')!;
    const { product, kredit, valid_days, reference } = await c.req.json();
    const ref = typeof reference === 'string' ? reference.slice(0, 100) : undefined;

    if (product !== undefined) {
      if (!isKreditProductCode(product)) {
        return c.json({ error: `product must be one of: ${Object.keys(KREDIT_PRODUCTS).join(', ')}` }, 400);
      }
      await kreditService.grantProduct(userId, product, ref);
    } else {
      if (typeof kredit !== 'number' || !(kredit > 0) || kredit > 100_000) {
        return c.json({ error: 'kredit must be a number between 0 and 100000' }, 400);
      }
      if (valid_days !== undefined && valid_days !== null && (!Number.isInteger(valid_days) || valid_days < 1)) {
        return c.json({ error: 'valid_days must be a positive integer or null' }, 400);
      }
      await kreditService.grantKredit(userId, { source: 'admin', kredit, validDays: valid_days ?? null, reference: ref });
    }

    const status = await quotaService.getStatus(userId);
    return c.json({ success: true, usage: quotaService.quotaSummary(status) });
  } catch (error) {
    console.error('Error granting kredit:', error);
    return c.json({ error: 'Failed to grant kredit' }, 500);
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

    // Generate CSV (quoted; formula-like cells are neutralised for spreadsheets)
    const cell = (value: unknown) => {
      let text = value === null || value === undefined ? '' : String(value);
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const csvHeader =
      'User ID,Email,Name,Daily Kredit Used,Daily Limit,Daily %,Weekly Kredit Used,Weekly Limit,Weekly %,Monthly Kredit Used,Requests Today,Requests This Week,Is Admin,Access Enabled,Plan,Plan Expires,Extra Kredit\n';

    const csvRows = users.map(user => {
      return [
        user.user_id,
        user.email,
        user.name,
        user.daily_kredit_used,
        user.daily_kredit_limit,
        user.daily_percentage.toFixed(2),
        user.weekly_kredit_used,
        user.weekly_kredit_limit,
        user.weekly_percentage.toFixed(2),
        user.monthly_kredit_used,
        user.requests_today,
        user.requests_this_week,
        user.is_admin,
        user.token_access_enabled,
        user.plan,
        user.plan_expires_at ? new Date(user.plan_expires_at).toISOString() : '',
        user.extra_kredit,
      ].map(cell).join(',');
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
