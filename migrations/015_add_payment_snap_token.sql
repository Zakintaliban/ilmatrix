-- Migration 015: keep the Snap token so a pending checkout can reopen the
-- Snap popup on our checkout page (instead of redirecting to Midtrans).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS snap_token VARCHAR(100);
