-- Stop Console writers before running. Restore-test first; run as the application owner.
-- Adds optional current-session metrics without rewriting historical presence rows.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL ROLE :"app_role";
SELECT pg_advisory_xact_lock(1481785689);

ALTER TABLE user_online_sources
    ADD COLUMN online_since_at TIMESTAMPTZ,
    ADD COLUMN session_uplink_bytes BIGINT,
    ADD COLUMN session_downlink_bytes BIGINT,
    ADD CONSTRAINT user_online_sources_session_shape CHECK (
        (
            online_since_at IS NULL
            AND session_uplink_bytes IS NULL
            AND session_downlink_bytes IS NULL
        ) OR (
            online_since_at IS NOT NULL
            AND session_uplink_bytes IS NOT NULL
            AND session_downlink_bytes IS NOT NULL
            AND online_since_at <= last_observed_at
            AND session_uplink_bytes >= 0
            AND session_downlink_bytes >= 0
        )
    ) NOT VALID;

COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL ROLE :"app_role";
ALTER TABLE user_online_sources
    VALIDATE CONSTRAINT user_online_sources_session_shape;
COMMIT;
