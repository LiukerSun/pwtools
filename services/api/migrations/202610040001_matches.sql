CREATE TABLE matches (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL CHECK (char_length(original_name) BETWEEN 1 AND 255),
    image_content_type TEXT NOT NULL CHECK (image_content_type IN ('image/png', 'image/jpeg', 'image/webp')),
    image_bytes BYTEA NOT NULL,
    image_sha256 TEXT NOT NULL CHECK (image_sha256 ~ '^[0-9a-f]{64}$'),
    image_width INTEGER NOT NULL CHECK (image_width BETWEEN 1 AND 16000),
    image_height INTEGER NOT NULL CHECK (image_height BETWEEN 1 AND 16000),
    image_size INTEGER NOT NULL CHECK (image_size BETWEEN 1 AND 12582912 AND image_size = octet_length(image_bytes)),
    players JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(players) = 'array'),
    raw_text TEXT NOT NULL DEFAULT '',
    warnings JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(warnings) = 'array'),
    ocr_status TEXT NOT NULL CHECK (ocr_status IN ('completed', 'failed')),
    player_name TEXT NOT NULL DEFAULT '' CHECK (char_length(player_name) <= 80),
    outcome TEXT NOT NULL DEFAULT 'unknown' CHECK (outcome IN ('success', 'failed', 'unknown')),
    amount BIGINT CHECK (amount BETWEEN 0 AND 9000000000000),
    confirmed BOOLEAN NOT NULL DEFAULT false,
    played_at TIMESTAMPTZ,
    note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 1000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, image_sha256),
    CHECK (image_width::BIGINT * image_height <= 40000000),
    CHECK (NOT confirmed OR (char_length(trim(player_name)) > 0 AND outcome <> 'unknown' AND amount IS NOT NULL))
);

CREATE INDEX matches_owner_created_idx ON matches(user_id, created_at DESC, id DESC);
