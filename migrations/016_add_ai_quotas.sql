-- Migration 016: daily and weekly AI quotas (always on, independent of payments)
--
-- Every AI request is metered in kredit (cost-weighted, see src/config/inferenceCost.ts)
-- and counts against two hard limits per user: a daily and a weekly quota.
-- Days start at 00:00 and weeks on Monday 00:00 in AI_QUOTA_TIMEZONE (Asia/Jakarta).
--
-- Payment tables, plans and kredit grants are untouched: they only take part
-- in quotas while PAYMENTS_ENABLED=true.

-- Global defaults, editable by admins. NULL falls back to AI_DAILY_KREDIT_LIMIT / AI_WEEKLY_KREDIT_LIMIT.
CREATE TABLE IF NOT EXISTS ai_quota_settings (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    daily_kredit_limit NUMERIC(12, 2) CHECK (daily_kredit_limit >= 0),
    weekly_kredit_limit NUMERIC(12, 2) CHECK (weekly_kredit_limit >= 0),
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
INSERT INTO ai_quota_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- Per-user overrides (NULL = the global default). weekly_kredit_override (migration 012) is reused.
ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_kredit_override NUMERIC(12, 2);
COMMENT ON COLUMN users.daily_kredit_override IS 'Admin override of the daily AI quota (NULL = global default)';
COMMENT ON COLUMN users.weekly_kredit_override IS 'Admin override of the weekly AI quota (NULL = global default, or an active paid plan while payments are on)';

-- Usage per period: a new day or week is a new row, so resets need no job and
-- past periods stay as history.
CREATE TABLE IF NOT EXISTS ai_quota_usage (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period_type VARCHAR(4) NOT NULL CHECK (period_type IN ('day', 'week')),
    period_start DATE NOT NULL,
    kredit_used NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (kredit_used >= 0),
    request_count INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, period_type, period_start)
);

-- A reservation holds kredit while an AI request runs, so parallel requests
-- can't all pass the same check. It is settled with the real cost, released
-- (nothing was spent) or, if the server never finishes it, expired: an expired
-- reservation is charged in full, never dropped.
CREATE TABLE IF NOT EXISTS ai_quota_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tool VARCHAR(30) NOT NULL,
    -- Periods the request was admitted in: its cost lands there even if it ends after a reset
    day_start DATE NOT NULL,
    week_start DATE NOT NULL,
    reserved_kredit NUMERIC(12, 2) NOT NULL CHECK (reserved_kredit >= 0),
    charged_kredit NUMERIC(12, 2) NOT NULL DEFAULT 0,
    -- quota: counts against the quotas; exempt: admin; grant: paid kredit (payments on only)
    funded_by VARCHAR(10) NOT NULL DEFAULT 'quota' CHECK (funded_by IN ('quota', 'exempt', 'grant')),
    status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'settled', 'released', 'expired')),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    finished_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_ai_quota_reservations_active
    ON ai_quota_reservations(user_id, day_start, week_start) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_ai_quota_reservations_expiry
    ON ai_quota_reservations(expires_at) WHERE status = 'active';

COMMENT ON TABLE ai_quota_usage IS 'Kredit used per user per quota day/week (AI_QUOTA_TIMEZONE)';
COMMENT ON TABLE ai_quota_reservations IS 'Kredit held by running AI requests; settled, released or charged in full on expiry';
