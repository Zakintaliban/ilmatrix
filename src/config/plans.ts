/**
 * Plans and kredit products: the payment system's catalogue.
 *
 * Only used while payments are enabled (PAYMENTS_ENABLED=true): then an active
 * paid plan sets the weekly AI quota and passes/top-ups add kredit beyond the
 * quotas. These values are kept as they were; they are not rebalanced for the
 * daily/weekly quota system yet. Kredit itself is priced in inferenceCost.ts.
 * See docs/AUDIT_AND_STRATEGY_2026.md §16-17 for the pricing rationale.
 */

export type PlanCode = "free" | "bulanan" | "semester";

export interface Plan {
  code: PlanCode;
  name: string;
  /** Weekly AI quota while this plan is active and payments are enabled. */
  weeklyKredit: number;
  priceIdr: number;
  /** Length of a paid period; null = does not expire. */
  durationDays: number | null;
}

function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const PLANS: Record<PlanCode, Plan> = {
  free: {
    code: "free",
    name: "Gratis",
    weeklyKredit: envNumber("KREDIT_FREE_WEEKLY", 150),
    priceIdr: 0,
    durationDays: null,
  },
  bulanan: { code: "bulanan", name: "Bulanan", weeklyKredit: 900, priceIdr: 29_000, durationDays: 30 },
  semester: { code: "semester", name: "Semester", weeklyKredit: 700, priceIdr: 99_000, durationDays: 182 },
};

export function isPlanCode(value: unknown): value is PlanCode {
  return typeof value === "string" && value in PLANS;
}

export type KreditProductCode = "pass_7d" | "topup";

export interface KreditProduct {
  code: KreditProductCode;
  name: string;
  kredit: number;
  priceIdr: number;
  /** Validity after purchase; null = never expires. */
  validDays: number | null;
}

/** One-off kredit, used after the weekly allowance. */
export const KREDIT_PRODUCTS: Record<KreditProductCode, KreditProduct> = {
  pass_7d: { code: "pass_7d", name: "Pass 7 Hari", kredit: 1_000, priceIdr: 9_900, validDays: 7 },
  topup: { code: "topup", name: "Top-up", kredit: 600, priceIdr: 5_000, validDays: 90 },
};

export function isKreditProductCode(value: unknown): value is KreditProductCode {
  return typeof value === "string" && value in KREDIT_PRODUCTS;
}
