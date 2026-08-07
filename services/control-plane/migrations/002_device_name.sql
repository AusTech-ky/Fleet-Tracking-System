-- 002: friendly device name (added after the initial schema shipped).
--
-- 001_init.sql is the fresh-install schema and only runs on an empty volume
-- (docker-entrypoint-initdb.d). Existing databases need this incremental step,
-- so every schema change after the first release gets its own numbered file.
-- Idempotent so it is safe to re-run.

ALTER TABLE device ADD COLUMN IF NOT EXISTS name text;
