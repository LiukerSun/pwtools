CREATE TABLE users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND char_length(email) <= 254),
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 32),
    bio TEXT NOT NULL DEFAULT '' CHECK (char_length(bio) <= 500),
    avatar_color TEXT NOT NULL DEFAULT '#8b5cf6' CHECK (avatar_color ~ '^#[0-9a-f]{6}$'),
    game_tags TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(game_tags) <= 8),
    availability TEXT NOT NULL DEFAULT 'offline' CHECK (availability IN ('available', 'busy', 'offline')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    token_hash BYTEA PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

