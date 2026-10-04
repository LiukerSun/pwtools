-- Remove the discontinued public profile while preserving account identity and private ledger ownership.
-- No CASCADE: unexpected external dependencies must fail rather than delete unrelated data.
ALTER TABLE users
    DROP COLUMN display_name,
    DROP COLUMN bio,
    DROP COLUMN avatar_color,
    DROP COLUMN game_tags,
    DROP COLUMN availability;
