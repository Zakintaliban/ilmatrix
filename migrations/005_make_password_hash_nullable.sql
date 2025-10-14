-- Migration to make password_hash nullable for OAuth users
-- Run this to allow OAuth users without passwords

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Add comment to document the change
COMMENT ON COLUMN users.password_hash IS 'Password hash for email/password auth. NULL for OAuth users (Google, etc.)';