-- Migration 009: Add token usage fields to users table
-- Created: 2025-10-26
-- Purpose: Add monthly and weekly token limit tracking to users

-- Add token usage columns to users table
ALTER TABLE users
    -- Monthly token limits and tracking
    ADD COLUMN monthly_token_limit INTEGER DEFAULT 1000000 NOT NULL, -- 1M tokens per month
    ADD COLUMN monthly_tokens_used INTEGER DEFAULT 0 NOT NULL,
    ADD COLUMN monthly_usage_reset_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '1 month') NOT NULL,

    -- Weekly token limits and tracking
    ADD COLUMN weekly_token_limit INTEGER DEFAULT 250000 NOT NULL, -- 250k tokens per week
    ADD COLUMN weekly_tokens_used INTEGER DEFAULT 0 NOT NULL,
    ADD COLUMN weekly_usage_reset_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '1 week') NOT NULL,

    -- Admin flag for unlimited access
    ADD COLUMN is_admin BOOLEAN DEFAULT FALSE NOT NULL,

    -- Soft delete for token limit management
    ADD COLUMN token_access_enabled BOOLEAN DEFAULT TRUE NOT NULL,

    -- Add constraints
    ADD CONSTRAINT valid_monthly_tokens CHECK (monthly_tokens_used >= 0 AND monthly_tokens_used <= monthly_token_limit * 2),
    ADD CONSTRAINT valid_weekly_tokens CHECK (weekly_tokens_used >= 0 AND weekly_tokens_used <= weekly_token_limit * 2);

-- Indexes for efficient queries
CREATE INDEX idx_users_weekly_reset ON users(weekly_usage_reset_at);
CREATE INDEX idx_users_monthly_reset ON users(monthly_usage_reset_at);
CREATE INDEX idx_users_is_admin ON users(is_admin) WHERE is_admin = TRUE;
CREATE INDEX idx_users_token_access ON users(token_access_enabled) WHERE token_access_enabled = TRUE;

-- Function to reset weekly token usage for users whose reset time has passed
CREATE OR REPLACE FUNCTION reset_weekly_tokens()
RETURNS TABLE(user_id UUID, previous_usage INTEGER) AS $$
BEGIN
    RETURN QUERY
    UPDATE users
    SET
        weekly_tokens_used = 0,
        weekly_usage_reset_at = weekly_usage_reset_at + INTERVAL '1 week',
        updated_at = NOW()
    WHERE weekly_usage_reset_at <= NOW()
    AND token_access_enabled = TRUE
    RETURNING id, weekly_tokens_used;
END;
$$ language 'plpgsql';

-- Function to reset monthly token usage for users whose reset time has passed
CREATE OR REPLACE FUNCTION reset_monthly_tokens()
RETURNS TABLE(user_id UUID, previous_usage INTEGER) AS $$
BEGIN
    RETURN QUERY
    UPDATE users
    SET
        monthly_tokens_used = 0,
        monthly_usage_reset_at = monthly_usage_reset_at + INTERVAL '1 month',
        updated_at = NOW()
    WHERE monthly_usage_reset_at <= NOW()
    AND token_access_enabled = TRUE
    RETURNING id, monthly_tokens_used;
END;
$$ language 'plpgsql';

-- Function to check if user can use tokens
CREATE OR REPLACE FUNCTION can_user_use_tokens(p_user_id UUID, p_tokens_needed INTEGER)
RETURNS TABLE(
    can_use BOOLEAN,
    reason VARCHAR(100),
    weekly_remaining INTEGER,
    session_remaining INTEGER
) AS $$
DECLARE
    v_user RECORD;
    v_session RECORD;
    v_can_use BOOLEAN := FALSE;
    v_reason VARCHAR(100) := 'OK';
    v_weekly_remaining INTEGER;
    v_session_remaining INTEGER;
BEGIN
    -- Get user token info
    SELECT
        u.is_admin,
        u.token_access_enabled,
        u.weekly_token_limit,
        u.weekly_tokens_used,
        u.weekly_usage_reset_at
    INTO v_user
    FROM users u
    WHERE u.id = p_user_id;

    -- Check if user exists
    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'User not found'::VARCHAR(100), 0, 0;
        RETURN;
    END IF;

    -- Admin bypass
    IF v_user.is_admin THEN
        RETURN QUERY SELECT TRUE, 'Admin access'::VARCHAR(100), 999999999, 999999999;
        RETURN;
    END IF;

    -- Check if token access is enabled
    IF NOT v_user.token_access_enabled THEN
        RETURN QUERY SELECT FALSE, 'Token access disabled'::VARCHAR(100), 0, 0;
        RETURN;
    END IF;

    -- Calculate weekly remaining
    v_weekly_remaining := v_user.weekly_token_limit - v_user.weekly_tokens_used;

    -- Check weekly limit
    IF v_weekly_remaining < p_tokens_needed THEN
        RETURN QUERY SELECT FALSE, 'Weekly limit exceeded'::VARCHAR(100), v_weekly_remaining, 0;
        RETURN;
    END IF;

    -- Get active session
    SELECT
        s.id,
        s.session_token_limit,
        s.session_tokens_used,
        s.session_expires_at
    INTO v_session
    FROM token_usage_sessions s
    WHERE s.user_id = p_user_id
    AND s.is_active = TRUE
    AND s.session_expires_at > NOW()
    ORDER BY s.session_started_at DESC
    LIMIT 1;

    -- If no active session, user can create one
    IF NOT FOUND THEN
        v_session_remaining := 25000; -- Default session limit
        v_can_use := TRUE;
    ELSE
        -- Check session limit
        v_session_remaining := v_session.session_token_limit - v_session.session_tokens_used;

        IF v_session_remaining < p_tokens_needed THEN
            RETURN QUERY SELECT FALSE, 'Session limit exceeded'::VARCHAR(100), v_weekly_remaining, v_session_remaining;
            RETURN;
        END IF;

        v_can_use := TRUE;
    END IF;

    RETURN QUERY SELECT v_can_use, v_reason, v_weekly_remaining, v_session_remaining;
END;
$$ language 'plpgsql';

-- Function to update user token usage (atomic)
CREATE OR REPLACE FUNCTION update_user_token_usage(
    p_user_id UUID,
    p_tokens_used INTEGER,
    p_session_id UUID
)
RETURNS TABLE(
    success BOOLEAN,
    new_weekly_used INTEGER,
    new_session_used INTEGER
) AS $$
DECLARE
    v_new_weekly INTEGER;
    v_new_session INTEGER;
BEGIN
    -- Update user weekly usage
    UPDATE users
    SET
        weekly_tokens_used = weekly_tokens_used + p_tokens_used,
        monthly_tokens_used = monthly_tokens_used + p_tokens_used,
        updated_at = NOW()
    WHERE id = p_user_id
    RETURNING weekly_tokens_used INTO v_new_weekly;

    -- Update session usage
    UPDATE token_usage_sessions
    SET
        session_tokens_used = session_tokens_used + p_tokens_used,
        updated_at = NOW()
    WHERE id = p_session_id
    RETURNING session_tokens_used INTO v_new_session;

    RETURN QUERY SELECT TRUE, v_new_weekly, v_new_session;
END;
$$ language 'plpgsql';

-- Comments for documentation
COMMENT ON COLUMN users.monthly_token_limit IS 'Maximum tokens per month (default 1M)';
COMMENT ON COLUMN users.weekly_token_limit IS 'Maximum tokens per week (default 250k)';
COMMENT ON COLUMN users.monthly_tokens_used IS 'Tokens consumed in current month';
COMMENT ON COLUMN users.weekly_tokens_used IS 'Tokens consumed in current week';
COMMENT ON COLUMN users.monthly_usage_reset_at IS 'When monthly usage counter resets';
COMMENT ON COLUMN users.weekly_usage_reset_at IS 'When weekly usage counter resets';
COMMENT ON COLUMN users.is_admin IS 'Admin users have unlimited token access';
COMMENT ON COLUMN users.token_access_enabled IS 'Whether user can consume tokens (soft delete)';
