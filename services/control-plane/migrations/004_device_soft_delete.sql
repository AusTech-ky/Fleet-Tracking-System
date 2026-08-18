-- Soft delete for devices. A deleted device is hidden from every normal view
-- but its row — and therefore every position, trip and alert that references
-- its id — is preserved. Nothing is dropped.
--
-- The old DELETE was a hard delete, and position/trip/alert_event carry
-- device_id with NO foreign key: hard-deleting a device left thousands of
-- rows that could never be resolved back to a name or tenant again.

ALTER TABLE device ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- IMEI uniqueness only among LIVE devices. A deleted device keeps its IMEI
-- (so its history stays attributed to it), and the same physical tracker can
-- be provisioned again as a fresh row. Replace the global unique constraint
-- with a partial unique index.
ALTER TABLE device DROP CONSTRAINT IF EXISTS device_imei_key;
CREATE UNIQUE INDEX IF NOT EXISTS device_imei_live_uniq ON device (imei) WHERE deleted_at IS NULL;

-- Most reads filter on tenant + not-deleted.
CREATE INDEX IF NOT EXISTS device_tenant_live_idx ON device (tenant_id) WHERE deleted_at IS NULL;
