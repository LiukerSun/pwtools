ALTER TABLE service_orders
    ADD COLUMN transfer_history jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE service_orders ADD CONSTRAINT transfer_history_array
    CHECK (jsonb_typeof(transfer_history) = 'array');
