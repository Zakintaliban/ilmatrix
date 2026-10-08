-- Migration 013: store only a SHA-256 hash of each session token (S15)
-- A leaked database or backup no longer contains usable session cookies.
-- Existing sessions stay valid: their tokens are hashed in place. Guarded by a
-- marker in the column comment so running it twice can't hash a hash.
DO $$
BEGIN
  IF COALESCE(col_description('user_sessions'::regclass,
       (SELECT attnum FROM pg_attribute WHERE attrelid = 'user_sessions'::regclass AND attname = 'session_token')), '')
     NOT LIKE 'sha256:%' THEN
    UPDATE user_sessions SET session_token = encode(sha256(convert_to(session_token, 'UTF8')), 'hex');
    COMMENT ON COLUMN user_sessions.session_token IS
      'sha256: hex SHA-256 of the session cookie value, never the value itself (migration 013)';
  END IF;
END $$;
