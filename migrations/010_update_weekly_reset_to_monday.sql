-- Migration 010: Update weekly reset to Monday 00:00 UTC
-- Created: 2025-10-26
-- Purpose: Change weekly token reset from rolling 7-day to fixed Monday 00:00 UTC

-- Helper function to calculate next Monday 00:00 UTC
CREATE OR REPLACE FUNCTION get_next_monday_utc()
RETURNS TIMESTAMP WITH TIME ZONE AS $$
BEGIN
    -- date_trunc('week', ...) returns Monday 00:00 of current week
    -- Adding 1 week gives us next Monday 00:00
    RETURN date_trunc('week', (NOW() AT TIME ZONE 'UTC') + INTERVAL '1 week') AT TIME ZONE 'UTC';
END;
$$ language 'plpgsql' IMMUTABLE;

-- Update reset_weekly_tokens function to use Monday logic
CREATE OR REPLACE FUNCTION reset_weekly_tokens()
RETURNS TABLE(user_id UUID, previous_usage INTEGER) AS $$
BEGIN
    RETURN QUERY
    UPDATE users
    SET
        weekly_tokens_used = 0,
        -- Set to next Monday 00:00 UTC instead of +1 week
        weekly_usage_reset_at = get_next_monday_utc(),
        updated_at = NOW()
    WHERE weekly_usage_reset_at <= NOW()
    AND token_access_enabled = TRUE
    RETURNING id, weekly_tokens_used;
END;
$$ language 'plpgsql';

-- Update all existing users to have their reset on next Monday 00:00 UTC
UPDATE users
SET weekly_usage_reset_at = get_next_monday_utc(),
    updated_at = NOW()
WHERE weekly_usage_reset_at IS NOT NULL;

-- Update default value for new users
ALTER TABLE users
    ALTER COLUMN weekly_usage_reset_at SET DEFAULT get_next_monday_utc();

-- Add comment for documentation
COMMENT ON FUNCTION get_next_monday_utc() IS 'Returns next Monday 00:00 UTC for weekly token reset scheduling';
COMMENT ON COLUMN users.weekly_usage_reset_at IS 'Weekly usage resets every Monday at 00:00 UTC';
