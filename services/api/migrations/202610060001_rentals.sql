CREATE TABLE rental_accounts (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    note TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, id)
);

CREATE TABLE rental_sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id UUID NOT NULL,
    coin_per_yuan BIGINT NOT NULL CHECK (coin_per_yuan > 0),
    aw_price BIGINT NOT NULL CHECK (aw_price >= 0),
    helmet_price BIGINT NOT NULL CHECK (helmet_price >= 0),
    armor_price BIGINT NOT NULL CHECK (armor_price >= 0),
    initial_coins BIGINT NOT NULL CHECK (initial_coins >= 0),
    deposit_cents BIGINT NOT NULL CHECK (deposit_cents >= 0),
    final_cost_cents BIGINT CHECK (final_cost_cents >= 0),
    started_at TIMESTAMPTZ NOT NULL,
    returned_at TIMESTAMPTZ,
    note TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, account_id) REFERENCES rental_accounts(user_id, id),
    CHECK ((returned_at IS NULL) = (final_cost_cents IS NULL)),
    CHECK (returned_at IS NULL OR returned_at >= started_at)
);
CREATE UNIQUE INDEX rental_account_one_active ON rental_sessions(user_id, account_id) WHERE returned_at IS NULL;

ALTER TABLE service_orders
    ADD COLUMN price_cents BIGINT CHECK (price_cents BETWEEN 0 AND 1000000000000),
    ADD COLUMN participant_count INTEGER CHECK (participant_count BETWEEN 1 AND 100),
    ADD COLUMN commission_bps INTEGER CHECK (commission_bps BETWEEN 0 AND 10000),
    ADD COLUMN default_rental_session_id UUID,
    ADD CONSTRAINT order_finance_complete CHECK (
        (price_cents IS NULL AND participant_count IS NULL AND commission_bps IS NULL) OR
        (price_cents IS NOT NULL AND participant_count IS NOT NULL AND commission_bps IS NOT NULL)
    ),
    ADD FOREIGN KEY (user_id, default_rental_session_id) REFERENCES rental_sessions(user_id, id);

-- NULL is the user's own game account, including all historical records.
ALTER TABLE ledger_entries ADD COLUMN rental_session_id UUID,
    ADD FOREIGN KEY (user_id, rental_session_id) REFERENCES rental_sessions(user_id, id),
    ADD CHECK (kind <> 'adjustment' OR rental_session_id IS NULL);
ALTER TABLE matches ADD COLUMN rental_session_id UUID,
    ADD FOREIGN KEY (user_id, rental_session_id) REFERENCES rental_sessions(user_id, id),
    ADD CHECK (rental_session_id IS NULL OR order_id IS NOT NULL);
CREATE INDEX ledger_entries_rental ON ledger_entries(user_id, rental_session_id, order_id) WHERE rental_session_id IS NOT NULL;
CREATE INDEX matches_rental ON matches(user_id, rental_session_id, order_id) WHERE rental_session_id IS NOT NULL;

-- One source row is one actual round. Adjustments and screenshot drafts never count.
CREATE VIEW rental_rounds AS
    SELECT user_id, id, order_id, rental_session_id, occurred_at
    FROM ledger_entries WHERE kind IN ('progress', 'failure')
    UNION ALL
    SELECT user_id, id, order_id, rental_session_id, COALESCE(played_at, created_at)
    FROM matches WHERE confirmed AND order_id IS NOT NULL;

CREATE TRIGGER archive_rental_account_changed AFTER INSERT OR UPDATE OR DELETE ON rental_accounts
FOR EACH ROW EXECUTE FUNCTION queue_account_oss_archive();
CREATE TRIGGER archive_rental_session_changed AFTER INSERT OR UPDATE OR DELETE ON rental_sessions
FOR EACH ROW EXECUTE FUNCTION queue_account_oss_archive();

-- Advance the archive shape without replacing an already-uploaded immutable revision.
INSERT INTO account_oss_archives(user_id) SELECT id FROM users
ON CONFLICT(user_id) DO UPDATE SET revision=account_oss_archives.revision+1,next_attempt_at=now();
