/**
 * Payment entitlements: paid plans and kredit grants (passes, top-ups,
 * bonus kredit).
 *
 * Part of the payment system. They only affect AI use while payments are
 * enabled (PAYMENTS_ENABLED=true): an active paid plan sets the weekly quota
 * and grants pay for requests the quotas would refuse (soonest-expiring
 * first). While payments are disabled, plans and grants are kept as they are
 * and ignored. Quota enforcement itself lives in quotaService.ts.
 */
import { query } from "./databaseService.js";
import { KREDIT_PRODUCTS, PLANS, isPlanCode, type KreditProductCode, type PlanCode } from "../config/plans.js";

export interface KreditGrant {
  id: string;
  source: string;
  remaining: number;
  expiresAt: Date | null;
}

export interface PaymentEntitlements {
  plan: { code: PlanCode; name: string; expires_at: Date | null };
  /** Weekly quota from an active paid plan; null = the user's normal weekly quota. */
  weeklyLimit: number | null;
  grants: { source: string; remaining: number; expires_at: Date | null }[];
  extraRemaining: number;
}

/** Anything that can run a parameterised query (the pool helper or a transaction client). */
type Db = { query(text: string, params?: unknown[]): Promise<{ rows: any[] }> };

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

const ACTIVE_GRANTS_SQL = `
  SELECT id, source, kredit_total - kredit_used AS remaining, expires_at
  FROM kredit_grants
  WHERE user_id = $1 AND kredit_used < kredit_total AND (expires_at IS NULL OR expires_at > NOW())
  ORDER BY expires_at ASC NULLS LAST, created_at ASC`;

/** The user row's plan if it is still running, else free (`plan`, `plan_expires_at`). */
export function activePlan(user: any): PlanCode {
  const paidActive =
    isPlanCode(user.plan) && user.plan !== "free" && !!user.plan_expires_at && new Date(user.plan_expires_at) > new Date();
  return paidActive ? user.plan : "free";
}

/** Active paid plan and grants of a user row (`plan`, `plan_expires_at`, `id`). */
export async function paymentEntitlements(db: Db, user: any): Promise<PaymentEntitlements> {
  const plan = activePlan(user);
  const paidActive = plan !== "free";
  const { rows } = await db.query(ACTIVE_GRANTS_SQL, [user.id]);
  const grants = rows.map((g) => ({
    source: g.source as string,
    remaining: round2(num(g.remaining)),
    expires_at: g.expires_at ? new Date(g.expires_at) : null,
  }));
  return {
    plan: { code: plan, name: PLANS[plan].name, expires_at: paidActive ? new Date(user.plan_expires_at) : null },
    weeklyLimit: paidActive ? PLANS[plan].weeklyKredit : null,
    grants,
    extraRemaining: round2(grants.reduce((sum, g) => sum + g.remaining, 0)),
  };
}

/**
 * Take `amount` kredit from the user's grants, soonest-expiring first (run in
 * a transaction). Returns what the grants could not cover.
 */
export async function consumeGrants(db: Db, userId: string, amount: number): Promise<number> {
  let rest = round2(amount);
  const { rows } = await db.query(`${ACTIVE_GRANTS_SQL} FOR UPDATE`, [userId]);
  for (const grant of rows) {
    if (rest <= 0) break;
    const take = Math.min(rest, round2(num(grant.remaining)));
    await db.query(`UPDATE kredit_grants SET kredit_used = kredit_used + $2 WHERE id = $1`, [grant.id, take]);
    rest = round2(rest - take);
  }
  return rest;
}

/** Add kredit outside the quotas (pass, top-up or admin grant). */
export async function grantKredit(
  userId: string,
  grant: { source: string; kredit: number; validDays: number | null; reference?: string },
  db: Db = { query }
): Promise<void> {
  if (!(grant.kredit > 0)) throw new Error("Kredit must be positive");
  await db.query(
    `INSERT INTO kredit_grants (user_id, source, kredit_total, expires_at, reference)
     VALUES ($1, $2, $3, CASE WHEN $4::int IS NULL THEN NULL ELSE NOW() + make_interval(days => $4::int) END, $5)`,
    [userId, grant.source, round2(grant.kredit), grant.validDays, grant.reference || null]
  );
}

/** Grant a catalogue product (e.g. after a payment). Pass `db` to run inside a transaction. */
export async function grantProduct(userId: string, code: KreditProductCode, reference?: string, db: Db = { query }): Promise<void> {
  const product = KREDIT_PRODUCTS[code];
  await grantKredit(
    userId,
    {
      source: code,
      kredit: product.kredit,
      validDays: product.validDays,
      reference,
    },
    db
  );
}

/**
 * Put a user on a plan. Paid plans run for `days` (default: the plan's
 * duration), extending an active period of the same plan.
 */
export async function setPlan(userId: string, plan: PlanCode, days?: number, db: Db = { query }): Promise<void> {
  if (plan === "free") {
    await db.query(`UPDATE users SET plan = 'free', plan_expires_at = NULL, updated_at = NOW() WHERE id = $1`, [userId]);
    return;
  }
  const duration = days ?? PLANS[plan].durationDays ?? 30;
  await db.query(
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
