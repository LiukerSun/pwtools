-- Preserve old gross values, confirmed balances, private image references and object jobs.
ALTER TABLE service_orders DROP CONSTRAINT service_orders_kind_check;
ALTER TABLE service_orders ADD CONSTRAINT service_orders_kind_check CHECK (kind IN ('hourly','escort','single_round','wager'));
ALTER TABLE service_orders ADD COLUMN failure_trigger TEXT NOT NULL DEFAULT 'failed' CHECK (failure_trigger IN ('failed','failed_below_standard','below_standard'));
ALTER TABLE service_orders ADD COLUMN failure_standard_quantity BIGINT NOT NULL DEFAULT 0 CHECK (failure_standard_quantity BETWEEN 0 AND 9000000000000);
ALTER TABLE service_orders ADD COLUMN failure_mode TEXT NOT NULL DEFAULT 'manual' CHECK (failure_mode IN ('manual','fixed','shortfall'));
ALTER TABLE service_orders ADD COLUMN wager_item_id TEXT;
ALTER TABLE service_orders ADD COLUMN wager_item_name TEXT NOT NULL DEFAULT '' CHECK (char_length(wager_item_name)<=160);
ALTER TABLE service_orders ADD COLUMN wager_expected TEXT NOT NULL DEFAULT 'obtained' CHECK (wager_expected IN ('obtained','not_obtained'));
ALTER TABLE service_orders ADD COLUMN wager_condition TEXT NOT NULL DEFAULT 'appearance' CHECK (wager_condition IN ('appearance','extracted'));
ALTER TABLE service_orders ADD CONSTRAINT wager_requires_item CHECK (kind<>'wager' OR char_length(trim(wager_item_name))>0);

ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_kind_check;
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_kind_check CHECK (kind IN ('progress','failure','adjustment','item_result'));
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_quantity_kind CHECK ((kind='progress' AND quantity>=0) OR (kind='failure' AND quantity>=0) OR (kind='adjustment' AND quantity<>0) OR (kind='item_result' AND quantity=0));
ALTER TABLE ledger_entries ADD COLUMN amount BIGINT CHECK (amount BETWEEN 0 AND 9000000000000);
ALTER TABLE ledger_entries ADD COLUMN fake_amount BIGINT CHECK (fake_amount BETWEEN 0 AND 9000000000000);
ALTER TABLE ledger_entries ADD COLUMN outcome TEXT CHECK (outcome IN ('success','failed'));
ALTER TABLE ledger_entries ADD COLUMN item_obtained BOOLEAN;
ALTER TABLE ledger_entries ADD COLUMN failure_extra_amount BIGINT NOT NULL DEFAULT 0 CHECK (failure_extra_amount BETWEEN 0 AND 9000000000000);
UPDATE ledger_entries e SET amount=CASE WHEN o.kind='escort' AND e.kind='progress' THEN e.quantity WHEN o.kind='escort' AND e.kind='failure' THEN 0 END,
  fake_amount=CASE WHEN o.kind='escort' AND e.kind IN ('progress','failure') THEN 0 END,
  outcome=CASE WHEN o.kind='escort' AND e.kind='progress' THEN 'success' WHEN o.kind='escort' AND e.kind='failure' THEN 'failed' END,
  failure_extra_amount=CASE WHEN e.kind='failure' THEN e.quantity ELSE 0 END
FROM service_orders o WHERE o.user_id=e.user_id AND o.id=e.order_id;
ALTER TABLE ledger_entries ADD COLUMN net_amount BIGINT GENERATED ALWAYS AS (amount-fake_amount) STORED;
ALTER TABLE ledger_entries ADD COLUMN credited_amount BIGINT GENERATED ALWAYS AS (CASE WHEN outcome='success' THEN amount-fake_amount ELSE 0 END) STORED;
ALTER TABLE ledger_entries ADD CONSTRAINT entry_fake_within_gross CHECK (amount IS NULL OR fake_amount IS NULL OR fake_amount<=amount);

ALTER TABLE matches ADD COLUMN fake_amount BIGINT CHECK (fake_amount BETWEEN 0 AND 9000000000000);
UPDATE matches SET fake_amount=0;
ALTER TABLE matches ADD COLUMN item_obtained BOOLEAN;
ALTER TABLE matches ADD COLUMN manual_result_edited BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE matches ADD COLUMN failure_default_snapshot BIGINT CHECK (failure_default_snapshot BETWEEN 0 AND 9000000000000);
UPDATE matches m SET failure_default_snapshot=o.failure_default_quantity FROM service_orders o WHERE o.user_id=m.user_id AND o.id=m.order_id;
UPDATE matches SET manual_result_edited=true WHERE confirmed;
ALTER TABLE matches ADD COLUMN net_amount BIGINT GENERATED ALWAYS AS (amount-fake_amount) STORED;
ALTER TABLE matches ADD COLUMN credited_amount BIGINT GENERATED ALWAYS AS (CASE WHEN outcome='success' THEN amount-fake_amount ELSE 0 END) STORED;
ALTER TABLE matches ADD CONSTRAINT match_fake_within_gross CHECK (amount IS NULL OR fake_amount IS NULL OR fake_amount<=amount);
DO $$ DECLARE c RECORD; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='matches'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%confirmed%' LOOP
  EXECUTE format('ALTER TABLE matches DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
-- Monetary confirmations are additionally validated by the service; wager screenshots may omit money.
ALTER TABLE matches ADD CONSTRAINT matches_confirmed_result CHECK (NOT confirmed OR (char_length(trim(player_name))>0 AND outcome<>'unknown'));

-- Refresh private per-match JSON as well as the account archive triggered by the backfill.
INSERT INTO object_storage_jobs(object_key,user_id,match_id,operation,payload)
SELECT regexp_replace(image_object_key,'/original\.(png|jpg|webp)$','/record.json'),user_id,id,'snapshot',
 jsonb_build_object('schema_version',1,'record',to_jsonb(m)-'user_id'-'image_bytes'-'image_object_key')
FROM matches m WHERE image_object_key IS NOT NULL
ON CONFLICT(object_key) DO UPDATE SET operation='snapshot',payload=EXCLUDED.payload,available_at=now(),attempts=0,revision=object_storage_jobs.revision+1,updated_at=now();
