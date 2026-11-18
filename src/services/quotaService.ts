/**
 * AI usage quotas: a daily and a weekly kredit limit per user, both hard.
 *
 * Always on, independent of payments. Kredit is the provider-neutral cost
 * unit from inferenceCost.ts; this module never looks at model names.
 *
 * Periods: days start at 00:00 and weeks on Monday 00:00 in
 * AI_QUOTA_TIMEZONE (Asia/Jakarta), computed by Postgres. Usage is stored per
 * period (ai_quota_usage), so a new day or week starts at zero without a job.
 *
 * Every AI request goes through a reservation:
 *   reserve  - in one transaction with the user's row locked: expire stale
 *              reservations, then admit only if BOTH quotas have room for the
 *              request's conservative estimate, and hold that amount. Parallel
 *              requests therefore can't pass the same check.
 *   finish   - replace the hold with the real cost (0 = released). Idempotent:
 *              a finished reservation is never charged again.
 *   expire   - a reservation the server never finished (crash, lost stream) is
 *              charged its full reserved amount after RESERVATION_TTL_MS; a
 *              late finish corrects that to the real cost.
 * The cost lands in the day and week the request was admitted in, even if it
 * ends after a reset.
 *
 * Overshoot: admission needs room for the estimate, so a period goes over its
 * limit only when a request's real cost exceeds its reservation (e.g. a far
 * larger input than budgeted). Output is capped per tool, which bounds that.
 *
 * Exemptions: admins are reserved and charged like everyone (usage is
 * visible) but never refused for quota. Disabled accounts are always refused.
 * While payments are enabled, an active paid plan sets the weekly quota and
 * passes/top-ups/bonus kredit pay for requests the quotas would refuse; while
 * they are disabled, neither has any effect.
 */
import config from "../config/env.js";
import { query, transaction } from "./databaseService.js";
import { paymentEntitlements, consumeGrants, type PaymentEntitlements } from "./kreditService.js";
import { isPaymentsEnabled } from "./paymentService.js";

export type QuotaPeriod = "daily" | "weekly";
export type QuotaTool =
  | "explain"
  | "quiz"
  | "forum"
  | "exam"
  | "chat"
  | "mcq"
  | "flashcards"
  | "dialogue"
  | "ocr";

/** Longer than any request (streams and multi-image OCR end within minutes). */
export const RESERVATION_TTL_MS = 15 * 60 * 1000;

export interface QuotaWindow {
  used: number;
  reserved: number;
  limit: number;
  remaining: number;
  periodStart: string;
  resetsAt: Date;
  /** Where the limit comes from: a per-user override, a paid plan, the admin setting or the env default. */
  limitSource: "user" | "plan" | "admin" | "env";
}

export interface QuotaStatus {
  timezone: string;
  daily: QuotaWindow;
  weekly: QuotaWindow;
  /** Admins: metered but never refused for quota. */
  exempt: boolean;
  accessEnabled: boolean;
  /** Paid plan and extra kredit; null while payments are disabled. */
  payments: PaymentEntitlements | null;
}

export type ReserveResult =
  | { ok: true; reservationId: string; amount: number; fundedBy: "quota" | "exempt" | "grant"; status: QuotaStatus }
  | { ok: false; reason: "access_disabled"; status: QuotaStatus }
  | {
      ok: false;
      reason: "quota";
      /** The quota that lifts last, i.e. when the student can use AI again. */
      period: QuotaPeriod;
      exhausted: QuotaPeriod[];
      required: number;
      resetsAt: Date;
      status: QuotaStatus;
    };

export interface QuotaDefaults {
  daily: number;
  weekly: number;
  dailySource: "admin" | "env";
  weeklySource: "admin" | "env";
  updatedAt: Date | null;
}

type Db = { query(text: string, params?: unknown[]): Promise<{ rows: any[] }> };

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

interface Periods {
  dayStart: string;
  weekStart: string;
  monthStart: string;
  dayResetsAt: Date;
  weekResetsAt: Date;
}

/** Quota day and week containing `now`, and when they end, in the quota timezone. */
export async function periodsAt(now: Date, db: Db = { query }): Promise<Periods> {
  const { rows } = await db.query(
    `SELECT l::date::text AS day_start,
            date_trunc('week', l)::date::text AS week_start,
            date_trunc('month', l)::date::text AS month_start,
            (l::date + 1)::timestamp AT TIME ZONE $2 AS day_resets_at,
            (date_trunc('week', l) + INTERVAL '7 days') AT TIME ZONE $2 AS week_resets_at
     FROM (SELECT $1::timestamptz AT TIME ZONE $2 AS l) t`,
    [now, config.aiQuotaTimezone]
  );
  const r = rows[0];
  return {
    dayStart: r.day_start,
    weekStart: r.week_start,
    monthStart: r.month_start,
    dayResetsAt: new Date(r.day_resets_at),
    weekResetsAt: new Date(r.week_resets_at),
  };
}

/** Global daily/weekly defaults: the admin setting, else the env fallback. */
export async function getDefaults(db: Db = { query }): Promise<QuotaDefaults> {
  const { rows } = await db.query(
    `SELECT daily_kredit_limit, weekly_kredit_limit, updated_at FROM ai_quota_settings WHERE id`
  );
  const s = rows[0] || {};
  const daily = s.daily_kredit_limit ?? null;
  const weekly = s.weekly_kredit_limit ?? null;
  return {
    daily: daily === null ? config.aiDailyKreditLimit : num(daily),
    weekly: weekly === null ? config.aiWeeklyKreditLimit : num(weekly),
    dailySource: daily === null ? "env" : "admin",
    weeklySource: weekly === null ? "env" : "admin",
    updatedAt: daily === null && weekly === null ? null : s.updated_at ? new Date(s.updated_at) : null,
  };
}

/** Set the global defaults (null = back to the env fallback). */
export async function setDefaults(
  limits: { daily?: number | null; weekly?: number | null },
  adminId: string | null
): Promise<QuotaDefaults> {
  await query(
    `INSERT INTO ai_quota_settings (id, daily_kredit_limit, weekly_kredit_limit, updated_by, updated_at)
     VALUES (TRUE, $1, $2, $5, NOW())
     ON CONFLICT (id) DO UPDATE SET
       daily_kredit_limit = CASE WHEN $3 THEN EXCLUDED.daily_kredit_limit ELSE ai_quota_settings.daily_kredit_limit END,
       weekly_kredit_limit = CASE WHEN $4 THEN EXCLUDED.weekly_kredit_limit ELSE ai_quota_settings.weekly_kredit_limit END,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [
      limits.daily ?? null,
      limits.weekly ?? null,
      limits.daily !== undefined,
      limits.weekly !== undefined,
      adminId,
    ]
  );
  return getDefaults();
}

/** Per-user overrides (undefined = unchanged, null = back to the default). */
export async function setUserLimits(userId: string, limits: { daily?: number | null; weekly?: number | null }): Promise<void> {
  await query(
    `UPDATE users SET
       daily_kredit_override = CASE WHEN $4 THEN $2::numeric ELSE daily_kredit_override END,
       weekly_kredit_override = CASE WHEN $5 THEN $3::numeric ELSE weekly_kredit_override END,
       updated_at = NOW()
     WHERE id = $1`,
    [userId, limits.daily ?? null, limits.weekly ?? null, limits.daily !== undefined, limits.weekly !== undefined]
  );
}

/** Columns of `users` the quota needs. */
const USER_COLUMNS = `id, is_admin, token_access_enabled, daily_kredit_override, weekly_kredit_override, plan, plan_expires_at`;

/** Limits for one user (shared by status and the admin list). */
export function resolveLimits(
  user: any,
  defaults: QuotaDefaults,
  payments: Pick<PaymentEntitlements, "weeklyLimit"> | null
): { daily: number; weekly: number; dailySource: QuotaWindow["limitSource"]; weeklySource: QuotaWindow["limitSource"] } {
  const dailyOverride = user.daily_kredit_override;
  const weeklyOverride = user.weekly_kredit_override;
  const daily = dailyOverride !== null && dailyOverride !== undefined ? num(dailyOverride) : defaults.daily;
  const dailySource = dailyOverride !== null && dailyOverride !== undefined ? "user" : defaults.dailySource;
  if (weeklyOverride !== null && weeklyOverride !== undefined) {
    return { daily, dailySource, weekly: num(weeklyOverride), weeklySource: "user" };
  }
  if (payments?.weeklyLimit !== undefined && payments.weeklyLimit !== null) {
    return { daily, dailySource, weekly: payments.weeklyLimit, weeklySource: "plan" };
  }
  return { daily, dailySource, weekly: defaults.weekly, weeklySource: defaults.weeklySource };
}

async function loadStatus(db: Db, user: any, p: Periods): Promise<QuotaStatus> {
  // Sequential: inside a transaction these share one connection
  const defaults = await getDefaults(db);
  const usage = await db.query(
    `SELECT period_type, kredit_used FROM ai_quota_usage
     WHERE user_id = $1 AND ((period_type = 'day' AND period_start = $2) OR (period_type = 'week' AND period_start = $3))`,
    [user.id, p.dayStart, p.weekStart]
  );
  const reserved = await db.query(
    `SELECT COALESCE(SUM(reserved_kredit) FILTER (WHERE day_start = $2), 0) AS day,
            COALESCE(SUM(reserved_kredit) FILTER (WHERE week_start = $3), 0) AS week,
            COALESCE(SUM(reserved_kredit) FILTER (WHERE funded_by = 'grant'), 0) AS grant
     FROM ai_quota_reservations WHERE user_id = $1 AND status = 'active'`,
    [user.id, p.dayStart, p.weekStart]
  );
  const payments = isPaymentsEnabled() ? await paymentEntitlements(db, user) : null;
  const used = { day: 0, week: 0 };
  for (const row of usage.rows) used[row.period_type as "day" | "week"] = num(row.kredit_used);
  const held = reserved.rows[0];
  const limits = resolveLimits(user, defaults, payments);
  const window = (kind: "day" | "week"): QuotaWindow => {
    const limit = kind === "day" ? limits.daily : limits.weekly;
    const r = round2(num(held[kind]));
    return {
      used: round2(used[kind]),
      reserved: r,
      limit,
      remaining: round2(Math.max(0, limit - used[kind] - r)),
      periodStart: kind === "day" ? p.dayStart : p.weekStart,
      resetsAt: kind === "day" ? p.dayResetsAt : p.weekResetsAt,
      limitSource: kind === "day" ? limits.dailySource : limits.weeklySource,
    };
  };
  return {
    timezone: config.aiQuotaTimezone,
    daily: window("day"),
    weekly: window("week"),
    exempt: !!user.is_admin,
    accessEnabled: user.token_access_enabled !== false,
    payments: payments && {
      ...payments,
      extraRemaining: round2(Math.max(0, payments.extraRemaining - num(held.grant))),
    },
  };
}

async function addUsage(db: Db, userId: string, dayStart: string, weekStart: string, delta: number, requests: number) {
  if (delta === 0 && requests === 0) return;
  await db.query(
    `INSERT INTO ai_quota_usage (user_id, period_type, period_start, kredit_used, request_count)
     VALUES ($1, 'day', $2, GREATEST(0, $4::numeric), $5), ($1, 'week', $3, GREATEST(0, $4::numeric), $5)
     ON CONFLICT (user_id, period_type, period_start) DO UPDATE SET
       kredit_used = GREATEST(0, ai_quota_usage.kredit_used + $4::numeric),
       request_count = ai_quota_usage.request_count + $5,
       updated_at = NOW()`,
    [userId, dayStart, weekStart, round2(delta), requests]
  );
}

/** Charge this user's stale reservations in full (the user's row must be locked). */
async function expireForUser(db: Db, userId: string, now: Date): Promise<number> {
  const { rows } = await db.query(
    `UPDATE ai_quota_reservations
     SET status = 'expired', charged_kredit = reserved_kredit, finished_at = $2
     WHERE user_id = $1 AND status = 'active' AND expires_at <= $2
     RETURNING day_start::text, week_start::text, reserved_kredit, funded_by`,
    [userId, now]
  );
  for (const r of rows) {
    const amount = num(r.reserved_kredit);
    await addUsage(db, userId, r.day_start, r.week_start, amount, amount > 0 ? 1 : 0);
    if (r.funded_by === "grant") await consumeGrants(db, userId, amount);
  }
  if (rows.length) console.warn(`[QUOTA] Charged ${rows.length} expired reservation(s) in full for user ${userId}`);
  return rows.length;
}

async function lockUser(db: Db, userId: string): Promise<any> {
  const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 FOR UPDATE`, [userId]);
  if (!rows.length) throw new Error("User not found");
  return rows[0];
}

/**
 * Admit an AI request and hold `amount` kredit for it, or refuse it.
 * Throws only when the database can't answer (callers then fail closed).
 */
export async function reserve(userId: string, tool: QuotaTool, amount: number, now = new Date()): Promise<ReserveResult> {
  const need = round2(Math.max(0.01, amount));
  return transaction(async (db) => {
    const user = await lockUser(db, userId);
    await expireForUser(db, userId, now);
    const p = await periodsAt(now, db);
    const status = await loadStatus(db, user, p);
    if (!status.accessEnabled) return { ok: false, reason: "access_disabled", status } as const;

    let fundedBy: "quota" | "exempt" | "grant" = status.exempt ? "exempt" : "quota";
    const exhausted = (["daily", "weekly"] as const).filter((k) => status[k].remaining < need);
    if (!status.exempt && exhausted.length) {
      if (status.payments && status.payments.extraRemaining >= need) {
        fundedBy = "grant";
      } else {
        const period: QuotaPeriod = exhausted.includes("weekly") ? "weekly" : "daily";
        return { ok: false, reason: "quota", period, exhausted, required: need, resetsAt: status[period].resetsAt, status } as const;
      }
    }

    const { rows } = await db.query(
      `INSERT INTO ai_quota_reservations (user_id, tool, day_start, week_start, reserved_kredit, funded_by, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [userId, tool, p.dayStart, p.weekStart, need, fundedBy, now, new Date(now.getTime() + RESERVATION_TTL_MS)]
    );
    for (const k of ["daily", "weekly"] as const) {
      status[k].reserved = round2(status[k].reserved + need);
      status[k].remaining = round2(Math.max(0, status[k].remaining - need));
    }
    return { ok: true, reservationId: rows[0].id, amount: need, fundedBy, status } as const;
  });
}

/**
 * Replace a reservation's hold with what the request really cost (0 when
 * nothing was spent). Idempotent: returns null if it was already finished.
 * An expired reservation was charged in full; this corrects it to `kredit`.
 */
export async function finish(reservationId: string, kredit: number, now = new Date()): Promise<QuotaStatus | null> {
  const cost = round2(Math.max(0, kredit));
  return transaction(async (db) => {
    const owner = await db.query(`SELECT user_id FROM ai_quota_reservations WHERE id = $1`, [reservationId]);
    if (!owner.rows.length) return null;
    // Same lock order as reserve(): user, then reservation, then usage
    const user = await lockUser(db, owner.rows[0].user_id);
    const { rows } = await db.query(
      `SELECT status, day_start::text, week_start::text, charged_kredit, funded_by
       FROM ai_quota_reservations WHERE id = $1 FOR UPDATE`,
      [reservationId]
    );
    const r = rows[0];
    if (r.status === "settled" || r.status === "released") return null;

    const delta = round2(cost - num(r.charged_kredit));
    await addUsage(db, user.id, r.day_start, r.week_start, delta, r.status === "active" && cost > 0 ? 1 : 0);
    if (r.funded_by === "grant" && delta > 0) await consumeGrants(db, user.id, delta);
    await db.query(
      `UPDATE ai_quota_reservations SET status = $2, charged_kredit = $3, finished_at = $4 WHERE id = $1`,
      [reservationId, cost > 0 ? "settled" : "released", cost, now]
    );
    return loadStatus(db, user, await periodsAt(now, db));
  });
}

/** Current quotas (charges this user's stale reservations first). */
export async function getStatus(userId: string, now = new Date()): Promise<QuotaStatus> {
  return transaction(async (db) => {
    const user = await lockUser(db, userId);
    await expireForUser(db, userId, now);
    return loadStatus(db, user, await periodsAt(now, db));
  });
}

/** Charge every stale reservation in full (background sweep). Returns how many. */
export async function expireStale(now = new Date()): Promise<number> {
  const { rows } = await query(
    `SELECT DISTINCT user_id FROM ai_quota_reservations WHERE status = 'active' AND expires_at <= $1`,
    [now]
  );
  let total = 0;
  for (const { user_id } of rows) {
    total += await transaction(async (db) => {
      await lockUser(db, user_id);
      return expireForUser(db, user_id, now);
    });
  }
  return total;
}

/** Set today's and/or this week's usage back to zero (admin). Running requests keep their holds. */
export async function resetUsage(userId: string, periods: QuotaPeriod[], now = new Date()): Promise<QuotaStatus> {
  return transaction(async (db) => {
    const user = await lockUser(db, userId);
    const p = await periodsAt(now, db);
    for (const period of periods) {
      await db.query(
        `UPDATE ai_quota_usage SET kredit_used = 0, updated_at = NOW()
         WHERE user_id = $1 AND period_type = $2 AND period_start = $3`,
        [userId, period === "daily" ? "day" : "week", period === "daily" ? p.dayStart : p.weekStart]
      );
    }
    return loadStatus(db, user, p);
  });
}

/** Kredit used per quota day, most recent first (days without use are omitted). */
export async function recentDays(userId: string, days = 14, now = new Date()) {
  const p = await periodsAt(now);
  const { rows } = await query(
    `SELECT period_start::text AS date, kredit_used::float AS kredit, request_count AS requests
     FROM ai_quota_usage
     WHERE user_id = $1 AND period_type = 'day' AND period_start > $2::date - $3::int
     ORDER BY period_start DESC`,
    [userId, p.dayStart, days]
  );
  return rows as { date: string; kredit: number; requests: number }[];
}

/** API shape of a status (snake_case, ISO dates). */
export function quotaSummary(status: QuotaStatus) {
  const w = (q: QuotaWindow) => ({
    used: q.used,
    reserved: q.reserved,
    limit: q.limit,
    remaining: q.remaining,
    percentage: q.limit > 0 ? Math.min(100, round2(((q.used + q.reserved) / q.limit) * 100)) : 100,
    period_start: q.periodStart,
    resets_at: q.resetsAt,
    limit_source: q.limitSource,
  });
  return {
    unit: "kredit",
    timezone: status.timezone,
    daily: w(status.daily),
    weekly: w(status.weekly),
    exempt: status.exempt,
    access_enabled: status.accessEnabled,
    ...(status.payments
      ? {
          payments: {
            plan: status.payments.plan,
            extra: { remaining: status.payments.extraRemaining, grants: status.payments.grants },
          },
        }
      : {}),
  };
}
