CREATE TABLE weapon_build_codes (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    weapon_name TEXT NOT NULL CHECK (char_length(weapon_name) BETWEEN 1 AND 100),
    mode TEXT NOT NULL CHECK (mode IN ('烽火地带', '全面战场')),
    code TEXT NOT NULL CHECK (char_length(code) BETWEEN 8 AND 256),
    core_code TEXT NOT NULL CHECK (core_code ~ '^[A-Za-z0-9]{8,64}$'),
    note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 2000),
    attributes JSONB,
    lookup_status TEXT NOT NULL DEFAULT 'unmatched' CHECK (lookup_status IN ('matched','unmatched','unavailable','not_configured')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX weapon_build_codes_owner ON weapon_build_codes(user_id, updated_at DESC, id DESC);

-- Shared public provider data; private notes/codes never enter this cache.
CREATE TABLE weapon_build_code_catalog (
    mode TEXT NOT NULL,
    weapon_name TEXT NOT NULL,
    items JSONB NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (mode, weapon_name)
);
