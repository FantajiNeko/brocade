-- Add explicit Xray release policy and release-scoped two-generation observation to an existing
-- unified binary-release schema. Stop Console writers and back up before running this script.
-- Verify the resulting definition against 0001 before updating the SQLx version-1 checksum.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(1481785689);

ALTER TABLE binary_releases
    ADD COLUMN xray_strategy TEXT,
    ADD COLUMN xray_drain_timeout_seconds INTEGER,
    ADD CONSTRAINT binary_releases_xray_strategy_known CHECK (
        xray_strategy IS NULL OR xray_strategy IN ('restart', 'handoff', 'handoff-force')
    ),
    ADD CONSTRAINT binary_releases_xray_execution_shape CHECK (
        (component = 'agent' AND xray_strategy IS NULL AND xray_drain_timeout_seconds IS NULL)
        OR
        (component = 'xray' AND (
            (xray_strategy IS NULL AND xray_drain_timeout_seconds IS NULL)
            OR (xray_strategy = 'restart' AND xray_drain_timeout_seconds IS NULL)
            OR (
                xray_strategy IN ('handoff', 'handoff-force')
                AND xray_drain_timeout_seconds BETWEEN 10 AND 86400
            )
        ))
    );

ALTER TABLE binary_release_targets
    ADD COLUMN reported_forced_retirement BOOLEAN;

ALTER TABLE node_agent_state
    ADD COLUMN xray_upgrade JSONB,
    ADD CONSTRAINT node_agent_state_xray_upgrade_object CHECK (
        xray_upgrade IS NULL OR jsonb_typeof(xray_upgrade) = 'object'
    );

DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM binary_releases
         WHERE (component = 'agent'
                AND (xray_strategy IS NOT NULL OR xray_drain_timeout_seconds IS NOT NULL))
            OR (component = 'xray' AND NOT (
                (xray_strategy IS NULL AND xray_drain_timeout_seconds IS NULL)
                OR (xray_strategy = 'restart' AND xray_drain_timeout_seconds IS NULL)
                OR (xray_strategy IN ('handoff', 'handoff-force')
                    AND xray_drain_timeout_seconds BETWEEN 10 AND 86400)
            ))
    ) THEN
        RAISE EXCEPTION 'binary release execution shape verification failed';
    END IF;
END $$;
COMMIT;
