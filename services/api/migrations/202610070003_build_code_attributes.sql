ALTER TABLE weapon_build_codes ADD COLUMN manual_attributes JSONB;
ALTER TABLE weapon_build_codes ADD CONSTRAINT weapon_build_codes_manual_object
    CHECK (manual_attributes IS NULL OR jsonb_typeof(manual_attributes) = 'object');
