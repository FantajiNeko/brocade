-- Change only the default for new control-state rows; preserve explicitly stored fingerprints.
BEGIN;
ALTER TABLE control_state ALTER COLUMN reality_fingerprint SET DEFAULT 'safari';
COMMIT;
-- Reconcile version 1's migration checksum only after reviewing every pending schema change.
