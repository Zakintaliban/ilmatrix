-- Migration 014: payments (Midtrans Snap) and their audit trail (P1-5)
-- One row per checkout. Fulfilment (plan or kredit) happens at most once,
-- recorded in fulfilled_at under a row lock.

CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- Midtrans order_id: up to 50 chars of [A-Za-z0-9-_~.]
    order_id VARCHAR(50) UNIQUE NOT NULL,
    -- Kept (as NULL) when the account is deleted: payments are financial records
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    -- Plan code (bulanan, semester) or kredit product code (pass_7d, topup)
    product VARCHAR(20) NOT NULL,
    amount_idr INTEGER NOT NULL CHECK (amount_idr > 0),
    -- pending | paid | failed | expired | refunded
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'paid', 'failed', 'expired', 'refunded')),
    provider VARCHAR(20) NOT NULL DEFAULT 'midtrans',
    -- Last transaction_status / fraud_status / payment_type reported by Midtrans
    provider_status VARCHAR(30),
    fraud_status VARCHAR(20),
    payment_type VARCHAR(40),
    transaction_id VARCHAR(100),
    redirect_url TEXT,
    -- Problem that needs a person (e.g. amount mismatch, refund after fulfilment)
    review_note TEXT,
    paid_at TIMESTAMP WITH TIME ZONE,
    fulfilled_at TIMESTAMP WITH TIME ZONE,
    last_checked_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_user_created ON payments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_status_created ON payments(status, created_at DESC);

-- Every status we received or fetched, for disputes and debugging
CREATE TABLE IF NOT EXISTS payment_events (
    id BIGSERIAL PRIMARY KEY,
    order_id VARCHAR(50) NOT NULL REFERENCES payments(order_id) ON DELETE CASCADE,
    -- checkout | notification (raw webhook) | status_check (Get Status) | admin
    source VARCHAR(20) NOT NULL,
    transaction_status VARCHAR(30),
    payload JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_events_order ON payment_events(order_id, created_at);
