-- Migration 003: Add user dashboard tables for chat history and saved materials
-- Created: 2025-10-14

-- Chat sessions table to track user conversation sessions
CREATE TABLE chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_message_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    message_count INTEGER DEFAULT 0,
    is_archived BOOLEAN DEFAULT FALSE
);

-- Chat messages table to store individual messages within sessions
CREATE TABLE chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    material_id UUID, -- Optional reference to material if message relates to specific material
    endpoint VARCHAR(50), -- Which AI endpoint was used (e.g., 'explain', 'quiz', 'flashcards')
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    tokens_used INTEGER DEFAULT 0
);

-- User materials table for saving and organizing uploaded materials
CREATE TABLE user_materials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    material_id UUID NOT NULL, -- Links to physical file in uploads/
    title VARCHAR(255) NOT NULL,
    description TEXT,
    file_names TEXT[], -- Array of original filenames
    file_types TEXT[], -- Array of file types (pdf, docx, etc.)
    content_preview TEXT, -- First 500 chars of extracted content
    word_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    access_count INTEGER DEFAULT 0,
    is_favorite BOOLEAN DEFAULT FALSE,
    tags TEXT[] DEFAULT '{}' -- User-defined tags for organization
);

-- User usage statistics for dashboard insights
CREATE TABLE user_usage_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    materials_uploaded INTEGER DEFAULT 0,
    chat_messages_sent INTEGER DEFAULT 0,
    ai_requests_made INTEGER DEFAULT 0,
    total_tokens_used INTEGER DEFAULT 0,
    endpoints_used JSONB DEFAULT '{}', -- Track which AI features were used
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, date)
);

-- Indexes for optimal query performance
CREATE INDEX idx_chat_sessions_user_id ON chat_sessions(user_id);
CREATE INDEX idx_chat_sessions_updated_at ON chat_sessions(updated_at DESC);
CREATE INDEX idx_chat_sessions_last_message_at ON chat_sessions(last_message_at DESC);

CREATE INDEX idx_chat_messages_session_id ON chat_messages(session_id);
CREATE INDEX idx_chat_messages_created_at ON chat_messages(created_at);
CREATE INDEX idx_chat_messages_role ON chat_messages(role);

CREATE INDEX idx_user_materials_user_id ON user_materials(user_id);
CREATE INDEX idx_user_materials_created_at ON user_materials(created_at DESC);
CREATE INDEX idx_user_materials_last_accessed_at ON user_materials(last_accessed_at DESC);
CREATE INDEX idx_user_materials_is_favorite ON user_materials(is_favorite) WHERE is_favorite = TRUE;
CREATE INDEX idx_user_materials_tags ON user_materials USING GIN(tags);

CREATE INDEX idx_user_usage_stats_user_id ON user_usage_stats(user_id);
CREATE INDEX idx_user_usage_stats_date ON user_usage_stats(date DESC);
CREATE INDEX idx_user_usage_stats_user_date ON user_usage_stats(user_id, date);

-- Update triggers for maintaining updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_chat_sessions_updated_at 
    BEFORE UPDATE ON chat_sessions 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_materials_updated_at 
    BEFORE UPDATE ON user_materials 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_usage_stats_updated_at 
    BEFORE UPDATE ON user_usage_stats 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to automatically update chat session metadata when messages are added
CREATE OR REPLACE FUNCTION update_chat_session_on_message()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE chat_sessions 
        SET 
            last_message_at = NEW.created_at,
            message_count = message_count + 1,
            updated_at = NEW.created_at
        WHERE id = NEW.session_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE chat_sessions 
        SET 
            message_count = message_count - 1,
            updated_at = NOW()
        WHERE id = OLD.session_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_session_on_message_change
    AFTER INSERT OR DELETE ON chat_messages
    FOR EACH ROW EXECUTE FUNCTION update_chat_session_on_message();

-- Function to clean up old temporary materials (older than 7 days) for authenticated users
CREATE OR REPLACE FUNCTION cleanup_old_user_materials()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    -- Delete user_materials records older than 7 days that haven't been accessed recently
    DELETE FROM user_materials 
    WHERE last_accessed_at < NOW() - INTERVAL '7 days'
    AND access_count = 0;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ language 'plpgsql';

-- Comments for documentation
COMMENT ON TABLE chat_sessions IS 'Stores user conversation sessions with metadata for dashboard display';
COMMENT ON TABLE chat_messages IS 'Individual messages within chat sessions, linked to AI endpoints and materials';
COMMENT ON TABLE user_materials IS 'User-saved materials with metadata for organization and quick access';
COMMENT ON TABLE user_usage_stats IS 'Daily usage statistics for dashboard insights and analytics';