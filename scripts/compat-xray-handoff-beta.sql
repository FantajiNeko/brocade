-- Apply before starting a Console that reads xray_handoff_beta on an existing database.
-- Preserve every existing approved target and in-progress two-generation checkpoint.
BEGIN;
ALTER TABLE control_state ADD COLUMN IF NOT EXISTS xray_handoff_beta BOOLEAN NOT NULL DEFAULT FALSE;
COMMIT;
-- After checking the production migration checksum and all other pending schema changes,
-- update version 1's checksum to the exact build's 0001_init.sql SHA-384 separately.
