CREATE TABLE order_templates (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 80),
    title TEXT NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 120),
    kind TEXT NOT NULL CHECK (kind IN ('hourly','escort','single_round','wager')),
    target_quantity BIGINT NOT NULL CHECK (target_quantity BETWEEN 1 AND 9000000000000),
    failure_default_quantity BIGINT NOT NULL DEFAULT 0 CHECK (failure_default_quantity BETWEEN 0 AND 9000000000000),
    note TEXT NOT NULL DEFAULT '' CHECK (char_length(note)<=2000),
    failure_trigger TEXT NOT NULL DEFAULT 'failed' CHECK (failure_trigger IN ('failed','failed_below_standard','below_standard')),
    failure_standard_quantity BIGINT NOT NULL DEFAULT 0 CHECK (failure_standard_quantity BETWEEN 0 AND 9000000000000),
    failure_mode TEXT NOT NULL DEFAULT 'manual' CHECK (failure_mode IN ('manual','fixed','shortfall')),
    wager_item_id TEXT,
    wager_item_name TEXT NOT NULL DEFAULT '' CHECK (char_length(wager_item_name)<=160),
    wager_expected TEXT NOT NULL DEFAULT 'obtained' CHECK (wager_expected IN ('obtained','not_obtained')),
    wager_condition TEXT NOT NULL DEFAULT 'appearance' CHECK (wager_condition IN ('appearance','extracted')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id,id),
    CHECK (kind='escort' OR (failure_default_quantity=0 AND failure_standard_quantity=0 AND failure_trigger='failed' AND failure_mode='manual')),
    CHECK ((kind='wager' AND target_quantity=1 AND char_length(trim(wager_item_name))>0) OR (kind<>'wager' AND wager_item_id IS NULL AND wager_item_name='' AND wager_expected='obtained' AND wager_condition='appearance'))
);
CREATE INDEX templates_owner_updated_idx ON order_templates(user_id,updated_at DESC,id DESC);
CREATE TRIGGER archive_template_changed AFTER INSERT OR UPDATE OR DELETE ON order_templates
FOR EACH ROW EXECUTE FUNCTION queue_account_oss_archive();

-- A new archive shape must never overwrite an immutable object at an existing revision.
-- Preserve active leases: their old claim can finish, while this revision remains pending.
INSERT INTO account_oss_archives(user_id) SELECT id FROM users
ON CONFLICT(user_id) DO UPDATE SET revision=account_oss_archives.revision+1,next_attempt_at=now();
