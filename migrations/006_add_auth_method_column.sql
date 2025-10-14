-- Add auth_method column to track how user registered/logged in
-- This helps with analytics and user management

ALTER TABLE users ADD COLUMN auth_method VARCHAR(20) DEFAULT 'email' NOT NULL;

-- Add comment to document the column
COMMENT ON COLUMN users.auth_method IS 'Authentication method used: email, google, facebook, etc.';

-- Update existing users to have 'email' as default
UPDATE users SET auth_method = 'email' WHERE auth_method IS NULL;

-- Add index for faster queries on auth method
CREATE INDEX idx_users_auth_method ON users(auth_method);