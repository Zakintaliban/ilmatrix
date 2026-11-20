-- Migration 012: Kredit-based plan limits
--
-- Usage is now metered in cost-weighted "kredit" (1 kredit ~ Rp4 of AI cost,
-- priced per model in src/config/plans.ts) instead of raw tokens:
--   * every user has a plan (free | bulanan | semester) with a weekly kredit
--     allowance that resets Monday 00:00 UTC;
--   * passes and top-ups are kredit grants with an optional expiry, used after
--     the weekly allowance;
--   * raw token counters are kept for analytics only.
-- The 5-hour session cap is no longer enforced (it blocked exam-night study).

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS plan VARCHAR(20) NOT NULL DEFAULT 'free',
    ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS weekly_kredit_used NUMERIC(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS monthly_kredit_used NUMERIC(12, 2) NOT NULL DEFAULT 0,
    -- Admin override of the plan's weekly allowance (NULL = use the plan)
    ADD COLUMN IF NOT EXISTS weekly_kredit_override NUMERIC(12, 2);

-- These capped raw token counters at 2x the old token limits, so recording a
-- paid user's usage (or any request that overshoots) would fail.
ALTER TABLE users DROP CONSTRAINT IF EXISTS valid_weekly_tokens;
ALTER TABLE users DROP CONSTRAINT IF EXISTS valid_monthly_tokens;
ALTER TABLE token_usage_sessions DROP CONSTRAINT IF EXISTS valid_session_tokens;

ALTER TABLE token_usage_logs
    ADD COLUMN IF NOT EXISTS kredit_used NUMERIC(12, 2) NOT NULL DEFAULT 0;

-- Passes, top-ups and admin grants: kredit outside the weekly allowance
CREATE TABLE IF NOT EXISTS kredit_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source VARCHAR(30) NOT NULL,            -- pass_7d | topup | admin
    kredit_total NUMERIC(12, 2) NOT NULL CHECK (kredit_total > 0),
    kredit_used NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (kredit_used >= 0),
    expires_at TIMESTAMP WITH TIME ZONE,     -- NULL = never expires
    reference VARCHAR(100),                  -- payment or admin reference
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kredit_grants_user ON kredit_grants(user_id, expires_at);

-- Admin resets also clear kredit counters; monthly resets land on the first
-- day of the next month (the old "+1 month" could stay in the past)
CREATE OR REPLACE FUNCTION reset_weekly_tokens()
RETURNS TABLE(user_id UUID, previous_usage INTEGER) AS $$
BEGIN
    RETURN QUERY
    UPDATE users
    SET
        weekly_tokens_used = 0,
        weekly_kredit_used = 0,
        weekly_usage_reset_at = get_next_monday_utc(),
        updated_at = NOW()
    WHERE weekly_usage_reset_at <= NOW()
    AND token_access_enabled = TRUE
    RETURNING id, weekly_tokens_used;
END;
$$ language 'plpgsql';

CREATE OR REPLACE FUNCTION reset_monthly_tokens()
RETURNS TABLE(user_id UUID, previous_usage INTEGER) AS $$
BEGIN
    RETURN QUERY
    UPDATE users
    SET
        monthly_tokens_used = 0,
        monthly_kredit_used = 0,
        monthly_usage_reset_at = date_trunc('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + INTERVAL '1 month',
        updated_at = NOW()
    WHERE monthly_usage_reset_at <= NOW()
    AND token_access_enabled = TRUE
    RETURNING id, monthly_tokens_used;
END;
$$ language 'plpgsql';

COMMENT ON COLUMN users.plan IS 'free | bulanan | semester (allowances in src/config/plans.ts)';
COMMENT ON COLUMN users.weekly_kredit_used IS 'Kredit used from the weekly allowance since the last Monday reset';
COMMENT ON TABLE kredit_grants IS 'Passes, top-ups and admin grants, consumed after the weekly allowance';
