-- Migration 007: Create guest chat tables for persistent guest chat functionality
-- Created: 2025-10-26

-- Guest chat sessions table to track guest conversation sessions
CREATE TABLE guest_chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guest_fingerprint VARCHAR(32) NOT NULL,
    title VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_message_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    message_count INTEGER DEFAULT 0,
    is_migrated BOOLEAN DEFAULT FALSE,
    migrated_to_user_id UUID REFERENCES users(id),
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '30 days')
);

-- Guest chat messages table to store individual messages within guest sessions
CREATE TABLE guest_chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES guest_chat_sessions(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    material_id UUID, -- Optional reference to material if message relates to specific material
    endpoint VARCHAR(50), -- Which AI endpoint was used (e.g., 'explain', 'quiz', 'flashcards')
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    tokens_used INTEGER DEFAULT 0
);

-- Indexes for optimal query performance
CREATE INDEX idx_guest_sessions_fingerprint ON guest_chat_sessions(guest_fingerprint);
CREATE INDEX idx_guest_sessions_expires_at ON guest_chat_sessions(expires_at);
CREATE INDEX idx_guest_sessions_migrated ON guest_chat_sessions(is_migrated);
CREATE INDEX idx_guest_sessions_last_message_at ON guest_chat_sessions(last_message_at DESC);

CREATE INDEX idx_guest_messages_session_id ON guest_chat_messages(session_id);
CREATE INDEX idx_guest_messages_created_at ON guest_chat_messages(created_at);
CREATE INDEX idx_guest_messages_role ON guest_chat_messages(role);

-- Update triggers for maintaining updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_guest_chat_sessions_updated_at
    BEFORE UPDATE ON guest_chat_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to automatically update guest chat session metadata when messages are added
CREATE OR REPLACE FUNCTION update_guest_chat_session_on_message()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE guest_chat_sessions
        SET
            last_message_at = NEW.created_at,
            message_count = message_count + 1,
            updated_at = NEW.created_at
        WHERE id = NEW.session_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE guest_chat_sessions
        SET
            message_count = message_count - 1,
            updated_at = NOW()
        WHERE id = OLD.session_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_guest_session_on_message_change
    AFTER INSERT OR DELETE ON guest_chat_messages
    FOR EACH ROW EXECUTE FUNCTION update_guest_chat_session_on_message();

-- Function to clean up expired guest sessions (older than 30 days)
CREATE OR REPLACE FUNCTION cleanup_expired_guest_sessions()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    -- Delete expired guest sessions and their messages
    DELETE FROM guest_chat_sessions
    WHERE expires_at < NOW()
      AND is_migrated = FALSE;

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ language 'plpgsql';

-- Function to migrate guest chat session to authenticated user
CREATE OR REPLACE FUNCTION migrate_guest_session_to_user(
    p_guest_session_id UUID,
    p_user_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
    new_session_id UUID;
BEGIN
    -- Check if guest session exists and is not already migrated
    IF NOT EXISTS (
        SELECT 1 FROM guest_chat_sessions
        WHERE id = p_guest_session_id
          AND is_migrated = FALSE
    ) THEN
        RETURN FALSE;
    END IF;

    -- Start transaction
    BEGIN
        -- Create new authenticated chat session
        INSERT INTO chat_sessions (user_id, title, created_at, updated_at, last_message_at, message_count)
        SELECT
            p_user_id,
            title,
            created_at,
            updated_at,
            last_message_at,
            message_count
        FROM guest_chat_sessions
        WHERE id = p_guest_session_id
        RETURNING id INTO new_session_id;

        -- Copy all messages from guest session to authenticated session
        INSERT INTO chat_messages (session_id, role, content, material_id, endpoint, created_at, tokens_used)
        SELECT
            new_session_id,
            role,
            content,
            material_id,
            endpoint,
            created_at,
            tokens_used
        FROM guest_chat_messages
        WHERE session_id = p_guest_session_id
        ORDER BY created_at ASC;

        -- Mark guest session as migrated
        UPDATE guest_chat_sessions
        SET
            is_migrated = TRUE,
            migrated_to_user_id = p_user_id,
            updated_at = NOW()
        WHERE id = p_guest_session_id;

        RETURN TRUE;
    EXCEPTION
        WHEN OTHERS THEN
            -- Rollback will happen automatically
            RETURN FALSE;
    END;
END;
$$ language 'plpgsql';

-- Comments for documentation
COMMENT ON TABLE guest_chat_sessions IS 'Stores guest user conversation sessions with metadata for temporary persistence';
COMMENT ON TABLE guest_chat_messages IS 'Individual messages within guest chat sessions, linked to AI endpoints and materials';
COMMENT ON FUNCTION cleanup_expired_guest_sessions() IS 'Removes expired guest chat sessions and their messages';
COMMENT ON FUNCTION migrate_guest_session_to_user(UUID, UUID) IS 'Migrates a guest chat session to an authenticated user account';