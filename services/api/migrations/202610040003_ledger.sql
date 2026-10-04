CREATE TABLE bosses (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    boss_key TEXT NOT NULL CHECK (char_length(boss_key) BETWEEN 1 AND 80),
    display_name TEXT NOT NULL CHECK (char_length(trim(display_name)) BETWEEN 1 AND 80),
    game_id TEXT NOT NULL DEFAULT '' CHECK (char_length(game_id) <= 80),
    game_name TEXT NOT NULL DEFAULT '' CHECK (char_length(game_name) <= 80),
    notes TEXT NOT NULL DEFAULT '' CHECK (char_length(notes) <= 2000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, id),
    UNIQUE (user_id, boss_key)
);

-- Preserve historical originals. They acquire an order only through an explicit confirmation.
INSERT INTO bosses (id, user_id, boss_key, display_name, game_id, game_name)
SELECT gen_random_uuid(), user_id, boss_id, boss_player_name, boss_id, boss_player_name
FROM (
    SELECT DISTINCT ON (user_id, boss_id) user_id, boss_id, boss_player_name
    FROM (
        SELECT user_id, boss_id, boss_player_name, updated_at, 0 AS priority FROM match_settings
        UNION ALL
        SELECT user_id, boss_id, boss_player_name, updated_at, 1 AS priority FROM matches
        WHERE trim(boss_id) <> '' AND trim(boss_player_name) <> ''
    ) history
    ORDER BY user_id, boss_id, priority, updated_at DESC
) latest;

CREATE TABLE service_orders (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    boss_id UUID NOT NULL,
    title TEXT NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 120),
    kind TEXT NOT NULL CHECK (kind IN ('hourly', 'escort')),
    target_quantity BIGINT NOT NULL CHECK (target_quantity BETWEEN 1 AND 9000000000000),
    failure_default_quantity BIGINT NOT NULL DEFAULT 0 CHECK (failure_default_quantity BETWEEN 0 AND 9000000000000),
    note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 2000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, boss_id) REFERENCES bosses(user_id, id) ON DELETE CASCADE,
    CHECK (kind = 'escort' OR failure_default_quantity = 0)
);
CREATE INDEX orders_owner_boss_idx ON service_orders(user_id, boss_id, created_at DESC);

CREATE TABLE ledger_entries (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    order_id UUID NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('progress', 'failure', 'adjustment')),
    quantity BIGINT NOT NULL CHECK (quantity BETWEEN -9000000000000 AND 9000000000000),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 2000),
    idempotency_key UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (user_id, order_id) REFERENCES service_orders(user_id, id) ON DELETE CASCADE,
    UNIQUE (user_id, order_id, idempotency_key),
    CHECK ((kind = 'progress' AND quantity > 0) OR (kind = 'failure' AND quantity >= 0) OR (kind = 'adjustment' AND quantity <> 0))
);
CREATE INDEX ledger_order_time_idx ON ledger_entries(user_id, order_id, occurred_at DESC, id DESC);

ALTER TABLE matches ADD COLUMN order_id UUID;
ALTER TABLE matches ADD COLUMN failure_extra_amount BIGINT NOT NULL DEFAULT 0 CHECK (failure_extra_amount BETWEEN 0 AND 9000000000000);
ALTER TABLE matches ADD CONSTRAINT matches_owner_order_fk FOREIGN KEY (user_id, order_id) REFERENCES service_orders(user_id, id);
CREATE INDEX matches_owner_order_idx ON matches(user_id, order_id, created_at DESC) WHERE order_id IS NOT NULL;
