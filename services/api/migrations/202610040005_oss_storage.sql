ALTER TABLE matches ALTER COLUMN image_bytes DROP NOT NULL;
ALTER TABLE matches ADD COLUMN image_object_key TEXT;
ALTER TABLE matches ADD CONSTRAINT matches_image_storage CHECK (image_bytes IS NOT NULL OR image_object_key IS NOT NULL);
ALTER TABLE matches ADD CONSTRAINT matches_private_object_key CHECK (image_object_key IS NULL OR image_object_key LIKE 'pwtools/users/%');
CREATE UNIQUE INDEX matches_object_key_idx ON matches(image_object_key) WHERE image_object_key IS NOT NULL;

-- Durable record snapshot writes and exact-key deletions survive service/network interruptions.
-- No foreign key: a deletion must remain queued after the originating record is removed.
CREATE TABLE object_storage_jobs (
    object_key TEXT PRIMARY KEY CHECK (object_key LIKE 'pwtools/users/%'),
    user_id UUID NOT NULL,
    match_id UUID NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('snapshot', 'delete')),
    payload JSONB,
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts INTEGER NOT NULL DEFAULT 0,
    revision BIGINT NOT NULL DEFAULT 1,
    lease_token UUID,
    lease_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((operation = 'snapshot' AND payload IS NOT NULL) OR (operation = 'delete' AND payload IS NULL))
);
CREATE INDEX object_storage_jobs_ready_idx ON object_storage_jobs(available_at,updated_at);
