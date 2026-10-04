CREATE TABLE match_settings (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    boss_id TEXT NOT NULL CHECK (char_length(trim(boss_id)) BETWEEN 1 AND 80),
    boss_player_name TEXT NOT NULL CHECK (char_length(trim(boss_player_name)) BETWEEN 1 AND 80),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE matches ADD COLUMN boss_id TEXT NOT NULL DEFAULT '';
ALTER TABLE matches ADD COLUMN boss_player_name TEXT NOT NULL DEFAULT '';
ALTER TABLE matches DROP CONSTRAINT matches_user_id_image_sha256_key;
ALTER TABLE matches ADD CONSTRAINT matches_owner_boss_image_key UNIQUE (user_id, boss_id, image_sha256);
ALTER TABLE matches ADD CONSTRAINT matches_boss_id_length CHECK (char_length(boss_id) <= 80);
ALTER TABLE matches ADD CONSTRAINT matches_boss_name_length CHECK (char_length(boss_player_name) <= 80);
CREATE INDEX matches_owner_boss_created_idx ON matches(user_id, boss_id, created_at DESC, id DESC);
