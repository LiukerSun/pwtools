ALTER TABLE service_orders
    ADD COLUMN archived_at timestamptz,
    ADD COLUMN settlement_required boolean NOT NULL DEFAULT false,
    ADD COLUMN settlement_history jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE service_orders ADD CONSTRAINT settlement_history_array
    CHECK (jsonb_typeof(settlement_history) = 'array');
