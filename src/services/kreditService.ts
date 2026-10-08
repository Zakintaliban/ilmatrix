/**
 * Kredit balances and charging.
 *
 * Each user has a plan with a weekly allowance (reset Monday 00:00 UTC) and
 * may hold kredit grants (passes, top-ups, admin grants) with an optional
 * expiry. Charges use the weekly allowance first, then the grant that
 * expires soonest. A request is allowed while any kredit remains; its actual
 * cost may overshoot by at most that one request.
 */
import { query, transaction } from "./databaseService.js";
import {
  KREDIT_PRODUCTS,
  PLANS,
  isPlanCode,
  type KreditProductCode,
  type PlanCode,
} from "../config/plans.js";

export interface KreditGrant {
  id: string;
  source: string;
  remaining: number;
  expiresAt: Date | null;
}

export interface KreditStatus {
  plan: PlanCode;
  planName: string;
  planExpiresAt: Date | null;
  weeklyLimit: number;
  weeklyUsed: number;
  weeklyRemaining: number;
  weeklyResetsAt: Date;
  extraRemaining: number;
  grants: KreditGrant[];
  totalRemaining: number;
  monthlyUsed: number;
  monthlyResetsAt: Date;
  isAdmin: boolean;
  accessEnabled: boolean;
}

/** Anything that can run a parameterised query (the pool helper or a transaction client). */
type Db = { query(text: string, params?: unknown[]): Promise<unknown> };

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

/** Reset this user's weekly/monthly counters if their reset time has passed. */
const LAZY_RESET_SQL = [
  `UPDATE users
   SET weekly_tokens_used = 0, weekly_kredit_used = 0, weekly_usage_reset_at = get_next_monday_utc()
   WHERE id = $1 AND weekly_usage_reset_at <= NOW()`,
  `UPDATE users
   SET monthly_tokens_used = 0, monthly_kredit_used = 0,
       monthly_usage_reset_at = date_trunc('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + INTERVAL '1 month'
   WHERE id = $1 AND monthly_usage_reset_at <= NOW()`,
];

const USER_SQL = `
  SELECT plan, plan_expires_at, weekly_kredit_used, monthly_kredit_used, weekly_kredit_override,
         weekly_usage_reset_at, monthly_usage_reset_at, is_admin, token_access_enabled
  FROM users WHERE id = $1`;

const GRANTS_SQL = `
  SELECT id, source, kredit_total - kredit_used AS remaining, expires_at
  FROM kredit_grants
  WHERE user_id = $1 AND kredit_used < kredit_total AND (expires_at IS NULL OR expires_at > NOW())
  ORDER BY expires_at ASC NULLS LAST, created_at ASC`;

async function resetIfDue(db: Db, userId: string): Promise<void> {
  for (const sql of LAZY_RESET_SQL) await db.query(sql, [userId]);
}

/** Apply this user's weekly/monthly reset if it is due. */
export async function resetUsageIfDue(userId: string): Promise<void> {
  await resetIfDue({ query }, userId);
}

/**
 * Build a status from a users row (USER_SQL columns) and active grant rows
 * (`remaining`, optionally `id`, `source`, `expires_at`).
 */
export function buildStatus(user: any, grantRows: any[]): KreditStatus {
  const planActive =
    isPlanCode(user.plan) &&
    (user.plan === "free" || (user.plan_expires_at && new Date(user.plan_expires_at) > new Date()));
  const plan: PlanCode = planActive ? user.plan : "free";
  const weeklyLimit =
    user.weekly_kredit_override !== null && user.weekly_kredit_override !== undefined
      ? num(user.weekly_kredit_override)
      : PLANS[plan].weeklyKredit;
  const weeklyUsed = round2(num(user.weekly_kredit_used));
  const weeklyRemaining = round2(Math.max(0, weeklyLimit - weeklyUsed));
  const grants = grantRows.map((g) => ({
    id: g.id,
    source: g.source,
    remaining: round2(num(g.remaining)),
    expiresAt: g.expires_at ? new Date(g.expires_at) : null,
  }));
  const extraRemaining = round2(grants.reduce((sum, g) => sum + g.remaining, 0));

  return {
    plan,
    planName: PLANS[plan].name,
    planExpiresAt: planActive && plan !== "free" ? new Date(user.plan_expires_at) : null,
    weeklyLimit,
    weeklyUsed,
    weeklyRemaining,
    weeklyResetsAt: new Date(user.weekly_usage_reset_at),
    extraRemaining,
    grants,
    totalRemaining: round2(weeklyRemaining + extraRemaining),
    monthlyUsed: round2(num(user.monthly_kredit_used)),
    monthlyResetsAt: new Date(user.monthly_usage_reset_at),
    isAdmin: !!user.is_admin,
    accessEnabled: user.token_access_enabled !== false,
  };
}

/** Current balance (applies any due weekly/monthly reset first). */
export async function getKreditStatus(userId: string): Promise<KreditStatus> {
  await resetIfDue({ query }, userId);
  const userResult = await query(USER_SQL, [userId]);
  if (!userResult.rows.length) throw new Error("User not found");
  const grantResult = await query(GRANTS_SQL, [userId]);
  return buildStatus(userResult.rows[0], grantResult.rows);
}

/** Whether the user may start another AI request. */
export function canUseAI(status: KreditStatus): boolean {
  if (status.isAdmin) return true;
  return status.accessEnabled && status.totalRemaining > 0;
}

/**
 * Charge kredit for a completed AI request and record its raw tokens.
 * Admins are recorded but never limited.
 */
export async function chargeKredit(userId: string, kredit: number, tokens = 0): Promise<KreditStatus> {
  const amount = round2(Math.max(0, kredit));
  return transaction(async (client) => {
    await resetIfDue(client, userId);
    const userResult = await client.query(`${USER_SQL} FOR UPDATE`, [userId]);
    if (!userResult.rows.length) throw new Error("User not found");
    const grantResult = await client.query(`${GRANTS_SQL} FOR UPDATE`, [userId]);
    const before = buildStatus(userResult.rows[0], grantResult.rows);

    let rest = amount;
    const fromWeekly = before.isAdmin ? rest : Math.min(rest, before.weeklyRemaining);
    rest = round2(rest - fromWeekly);

    for (const grant of before.grants) {
      if (rest <= 0) break;
      const take = Math.min(rest, grant.remaining);
      await client.query(`UPDATE kredit_grants SET kredit_used = kredit_used + $2 WHERE id = $1`, [grant.id, take]);
      rest = round2(rest - take);
    }

    // Anything left (the last request overshooting the balance) counts against the week
    await client.query(
      `UPDATE users
       SET weekly_kredit_used = weekly_kredit_used + $2,
           monthly_kredit_used = monthly_kredit_used + $3,
           weekly_tokens_used = weekly_tokens_used + $4,
           monthly_tokens_used = monthly_tokens_used + $4,
           updated_at = NOW()
       WHERE id = $1`,
      [userId, round2(fromWeekly + rest), amount, Math.max(0, Math.round(tokens))]
    );

    const after = await client.query(USER_SQL, [userId]);
    const afterGrants = await client.query(GRANTS_SQL, [userId]);
    return buildStatus(after.rows[0], afterGrants.rows);
  });
}

/** Add kredit outside the weekly allowance (pass, top-up or admin grant). */
export async function grantKredit(
  userId: string,
  grant: { source: string; kredit: number; validDays: number | null; reference?: string }
): Promise<void> {
  if (!(grant.kredit > 0)) throw new Error("Kredit must be positive");
  await query(
    `INSERT INTO kredit_grants (user_id, source, kredit_total, expires_at, reference)
     VALUES ($1, $2, $3, CASE WHEN $4::int IS NULL THEN NULL ELSE NOW() + make_interval(days => $4::int) END, $5)`,
    [userId, grant.source, round2(grant.kredit), grant.validDays, grant.reference || null]
  );
}

/** Grant a catalogue product (e.g. after a payment). */
export async function grantProduct(userId: string, code: KreditProductCode, reference?: string): Promise<void> {
  const product = KREDIT_PRODUCTS[code];
  await grantKredit(userId, {
    source: code,
    kredit: product.kredit,
    validDays: product.validDays,
    reference,
  });
}

/**
 * Put a user on a plan. Paid plans run for `days` (default: the plan's
 * duration), extending an active period of the same plan.
 */
export async function setPlan(userId: string, plan: PlanCode, days?: number): Promise<void> {
  if (plan === "free") {
    await query(`UPDATE users SET plan = 'free', plan_expires_at = NULL, updated_at = NOW() WHERE id = $1`, [userId]);
    return;
  }
  const duration = days ?? PLANS[plan].durationDays ?? 30;
  await query(
    `UPDATE users
     SET plan_expires_at = CASE
           WHEN plan = $2 AND plan_expires_at > NOW() THEN plan_expires_at
           ELSE NOW()
         END + make_interval(days => $3::int),
         plan = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [userId, plan, duration]
  );
}

/** Override the weekly allowance for one user (null restores the plan's). */
export async function setWeeklyOverride(userId: string, kredit: number | null): Promise<void> {
  await query(`UPDATE users SET weekly_kredit_override = $2, updated_at = NOW() WHERE id = $1`, [
    userId,
    kredit === null ? null : round2(kredit),
  ]);
}
