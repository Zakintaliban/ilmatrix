-- Add new columns to users table
ALTER TABLE users 
ADD COLUMN username VARCHAR(255) UNIQUE,
ADD COLUMN birth_date DATE,
ADD COLUMN country VARCHAR(100),
ADD COLUMN email_verified BOOLEAN DEFAULT false,
ADD COLUMN email_verification_token VARCHAR(255),
ADD COLUMN email_verification_expires TIMESTAMP WITH TIME ZONE;

-- Create index for username and email verification
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email_verification ON users(email_verification_token);