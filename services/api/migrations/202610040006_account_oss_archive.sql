CREATE TABLE account_oss_archives (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    uploaded_revision BIGINT NOT NULL DEFAULT 0 CHECK (uploaded_revision >= 0),
    failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_token UUID,
    leased_until TIMESTAMPTZ,
    last_uploaded_at TIMESTAMPTZ
);

CREATE FUNCTION queue_account_oss_archive() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id UUID;
BEGIN
    IF TG_TABLE_NAME = 'users' THEN
        owner_id := NEW.id;
    ELSIF TG_OP = 'DELETE' THEN
        owner_id := OLD.user_id;
    ELSE
        owner_id := NEW.user_id;
    END IF;
    IF EXISTS (SELECT 1 FROM users WHERE id = owner_id) THEN
        INSERT INTO account_oss_archives(user_id) VALUES(owner_id)
        ON CONFLICT (user_id) DO UPDATE
        SET revision = account_oss_archives.revision + 1, next_attempt_at = now();
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER archive_account_created AFTER INSERT ON users
FOR EACH ROW EXECUTE FUNCTION queue_account_oss_archive();
CREATE TRIGGER archive_boss_changed AFTER INSERT OR UPDATE OR DELETE ON bosses
FOR EACH ROW EXECUTE FUNCTION queue_account_oss_archive();
CREATE TRIGGER archive_order_changed AFTER INSERT OR UPDATE OR DELETE ON service_orders
FOR EACH ROW EXECUTE FUNCTION queue_account_oss_archive();
CREATE TRIGGER archive_entry_changed AFTER INSERT OR UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION queue_account_oss_archive();
CREATE TRIGGER archive_match_changed AFTER INSERT OR UPDATE OR DELETE ON matches
FOR EACH ROW EXECUTE FUNCTION queue_account_oss_archive();
CREATE TRIGGER archive_match_settings_changed AFTER INSERT OR UPDATE OR DELETE ON match_settings
FOR EACH ROW EXECUTE FUNCTION queue_account_oss_archive();

INSERT INTO account_oss_archives(user_id) SELECT id FROM users;
