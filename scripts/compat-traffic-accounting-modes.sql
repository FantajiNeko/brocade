-- Add selectable machine and user traffic-accounting modes to an existing Brocade database.
-- Stop Console writers, back up and rehearse against an isolated restored database first.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL ROLE :"app_role";
SELECT pg_advisory_xact_lock(1481785689);

ALTER TABLE users
    ADD COLUMN traffic_accounting_mode TEXT DEFAULT 'single' NOT NULL;
ALTER TABLE users
    ADD CONSTRAINT users_traffic_accounting_mode_check
    CHECK (traffic_accounting_mode IN ('single', 'double'));

ALTER TABLE node_traffic_policy
    ADD COLUMN accounting_mode TEXT DEFAULT 'bidirectional_sum' NOT NULL;
ALTER TABLE node_traffic_policy
    ADD CONSTRAINT node_traffic_policy_accounting_mode
    CHECK (accounting_mode IN ('bidirectional_sum', 'bidirectional_max', 'outbound_only', 'inbound_only'));

ALTER TABLE node_traffic_calibrations
    ADD COLUMN accounting_mode TEXT DEFAULT 'bidirectional_sum' NOT NULL,
    ADD COLUMN accounted_rx_bytes NUMERIC(20,0),
    ADD COLUMN accounted_tx_bytes NUMERIC(20,0);
ALTER TABLE node_traffic_calibrations
    ADD CONSTRAINT node_traffic_calibrations_accounting_mode
        CHECK (accounting_mode IN ('bidirectional_sum', 'bidirectional_max', 'outbound_only', 'inbound_only')),
    ADD CONSTRAINT node_traffic_calibrations_directional_nonnegative
        CHECK (
            (accounted_rx_bytes IS NULL AND accounted_tx_bytes IS NULL)
            OR (
                accounted_rx_bytes IS NOT NULL
                AND accounted_tx_bytes IS NOT NULL
                AND accounted_rx_bytes >= 0
                AND accounted_tx_bytes >= 0
            )
        );

ALTER TABLE node_traffic_forecasts
    ADD COLUMN accounting_mode TEXT DEFAULT 'bidirectional_sum' NOT NULL;
ALTER TABLE node_traffic_forecasts
    ADD CONSTRAINT node_traffic_forecasts_accounting_mode
    CHECK (accounting_mode IN ('bidirectional_sum', 'bidirectional_max', 'outbound_only', 'inbound_only'));

COMMIT;
