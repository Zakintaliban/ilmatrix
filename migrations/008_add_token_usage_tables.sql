-- Migration 008: Add token usage tracking tables
-- Created: 2025-10-26
-- Purpose: Implement Claude Code-style token usage system with session, weekly, and monthly limits

-- Token usage sessions table to track 5-hour session windows
CREATE TABLE token_usage_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_tokens_used INTEGER DEFAULT 0,
    session_token_limit INTEGER DEFAULT 25000, -- 25k per session
    session_started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    session_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Ensure expiry is after start
    CONSTRAINT valid_session_expiry CHECK (session_expires_at > session_started_at),

    -- Ensure tokens used doesn't exceed limit
    CONSTRAINT valid_session_tokens CHECK (session_tokens_used >= 0 AND session_tokens_used <= session_token_limit)
);

-- Token usage logs table for detailed tracking and analytics
CREATE TABLE token_usage_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id UUID REFERENCES token_usage_sessions(id) ON DELETE SET NULL,
    tokens_used INTEGER NOT NULL,
    endpoint VARCHAR(100) NOT NULL, -- AI endpoint used (e.g., '/api/explain', '/api/quiz')
    model_used VARCHAR(100), -- Groq model name
    request_type VARCHAR(50), -- Type of request (explain, quiz, chat, etc.)
    material_id UUID, -- Optional reference to material
    prompt_tokens INTEGER DEFAULT 0, -- Input tokens
    completion_tokens INTEGER DEFAULT 0, -- Output tokens
    metadata JSONB DEFAULT '{}', -- Additional context (e.g., quiz questions count, flashcard count)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Ensure tokens are positive
    CONSTRAINT valid_tokens_used CHECK (tokens_used > 0)
);

-- Indexes for optimal query performance
CREATE INDEX idx_token_usage_sessions_user_id ON token_usage_sessions(user_id);
CREATE INDEX idx_token_usage_sessions_user_active ON token_usage_sessions(user_id, is_active) WHERE is_active = TRUE;
CREATE INDEX idx_token_usage_sessions_expires_at ON token_usage_sessions(session_expires_at);
CREATE INDEX idx_token_usage_sessions_started_at ON token_usage_sessions(session_started_at DESC);

CREATE INDEX idx_token_usage_logs_user_id ON token_usage_logs(user_id);
CREATE INDEX idx_token_usage_logs_session_id ON token_usage_logs(session_id);
CREATE INDEX idx_token_usage_logs_created_at ON token_usage_logs(created_at DESC);
CREATE INDEX idx_token_usage_logs_endpoint ON token_usage_logs(endpoint);
CREATE INDEX idx_token_usage_logs_user_date ON token_usage_logs(user_id, created_at);

-- Update trigger for token_usage_sessions
CREATE TRIGGER update_token_usage_sessions_updated_at
    BEFORE UPDATE ON token_usage_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to automatically deactivate expired sessions
CREATE OR REPLACE FUNCTION deactivate_expired_sessions()
RETURNS INTEGER AS $$
DECLARE
    deactivated_count INTEGER;
BEGIN
    UPDATE token_usage_sessions
    SET is_active = FALSE, updated_at = NOW()
    WHERE is_active = TRUE
    AND session_expires_at < NOW();

    GET DIAGNOSTICS deactivated_count = ROW_COUNT;
    RETURN deactivated_count;
END;
$$ language 'plpgsql';

-- Function to get or create active session for a user
CREATE OR REPLACE FUNCTION get_or_create_active_session(p_user_id UUID)
RETURNS UUID AS $$
DECLARE
    v_session_id UUID;
    v_session_expires_at TIMESTAMP WITH TIME ZONE;
    v_session_limit INTEGER := 25000;
BEGIN
    -- First, deactivate any expired sessions for this user
    UPDATE token_usage_sessions
    SET is_active = FALSE, updated_at = NOW()
    WHERE user_id = p_user_id
    AND is_active = TRUE
    AND session_expires_at < NOW();

    -- Try to get active session that hasn't expired
    SELECT id INTO v_session_id
    FROM token_usage_sessions
    WHERE user_id = p_user_id
    AND is_active = TRUE
    AND session_expires_at > NOW()
    ORDER BY session_started_at DESC
    LIMIT 1;

    -- If no active session, create new one
    IF v_session_id IS NULL THEN
        v_session_expires_at := NOW() + INTERVAL '5 hours';

        INSERT INTO token_usage_sessions (
            user_id,
            session_token_limit,
            session_expires_at
        ) VALUES (
            p_user_id,
            v_session_limit,
            v_session_expires_at
        )
        RETURNING id INTO v_session_id;
    END IF;

    RETURN v_session_id;
END;
$$ language 'plpgsql';

-- Function to cleanup old token usage logs (older than 90 days)
CREATE OR REPLACE FUNCTION cleanup_old_token_logs()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM token_usage_logs
    WHERE created_at < NOW() - INTERVAL '90 days';

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ language 'plpgsql';

-- Comments for documentation
COMMENT ON TABLE token_usage_sessions IS 'Tracks 5-hour token usage sessions with 25k token limit per session';
COMMENT ON TABLE token_usage_logs IS 'Detailed log of all AI requests with token consumption for analytics';
COMMENT ON COLUMN token_usage_sessions.session_expires_at IS 'Session expires 5 hours after session_started_at';
COMMENT ON COLUMN token_usage_logs.metadata IS 'Additional context like quiz question count, flashcard count, etc.';
