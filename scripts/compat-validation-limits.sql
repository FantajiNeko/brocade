-- Relax the two validation limits changed by the 2026-10-20 audit.
-- Run on a restore first, with Console writers stopped and a database backup retained.
-- This script is repeatable and never changes SQLx migration checksums or model history.
-- Compare all other schema differences before advancing the version-1 checksum separately.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE :"app_role";
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(1481785689);

ALTER TABLE control_state
    DROP CONSTRAINT IF EXISTS control_state_geodata_cron_shape,
    DROP CONSTRAINT IF EXISTS control_state_reality_max_time_diff_ms_range;

ALTER TABLE control_state
    ADD CONSTRAINT control_state_geodata_cron_shape
        CHECK (length(btrim(geodata_cron)) > 0),
    ADD CONSTRAINT control_state_reality_max_time_diff_ms_range
        CHECK (reality_max_time_diff_ms IS NULL
            OR (reality_max_time_diff_ms >= 0 AND reality_max_time_diff_ms <= 9223372036854));

COMMIT;
