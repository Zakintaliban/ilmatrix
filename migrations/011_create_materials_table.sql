-- Persistent storage for extracted material text.
-- Replaces uploads/<id>.txt files, which were deleted 60 minutes after upload
-- (and on every redeploy), so chats and saved materials lost their context.
--
-- Retention (enforced by the app's background cleanup):
--   guest uploads (user_id NULL)   expire MATERIAL_TTL_MINUTES after last use
--   signed-in uploads              expire MATERIAL_USER_RETENTION_DAYS after last use
--   saved to the library           expires_at NULL, kept until deleted
-- Deleting a user deletes their materials (ON DELETE CASCADE).

CREATE TABLE IF NOT EXISTS materials (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    size_bytes INTEGER GENERATED ALWAYS AS (octet_length(content)) STORED,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    last_accessed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_materials_user_id ON materials(user_id);
CREATE INDEX IF NOT EXISTS idx_materials_expires_at ON materials(expires_at) WHERE expires_at IS NOT NULL;
