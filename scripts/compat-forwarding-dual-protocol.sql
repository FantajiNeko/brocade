-- Upgrade an existing user-managed forwarding schema to protocol-aware port ownership.
-- Stop old Console writers first, then run as the application role:
--   psql -X -v ON_ERROR_STOP=1 -d brocade -v app_role=brocade \
--     -f scripts/compat-forwarding-dual-protocol.sql
--
-- Existing entitlements are deliberately not expanded to UDP. Administrators can review and
-- edit them in the Console; only newly inserted entitlements receive the TCP+UDP default.

\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET LOCAL ROLE :"app_role";

ALTER TABLE forwarding_entitlements
    ALTER COLUMN udp_allowed SET DEFAULT true;

DROP INDEX forwarding_rules_active_port;
CREATE UNIQUE INDEX forwarding_rules_active_tcp_port
    ON forwarding_rules (node_id, listen_port)
    WHERE deleted_at IS NULL AND enabled AND protocol IN ('tcp', 'tcp_udp');
CREATE UNIQUE INDEX forwarding_rules_active_udp_port
    ON forwarding_rules (node_id, listen_port)
    WHERE deleted_at IS NULL AND enabled AND protocol IN ('udp', 'tcp_udp');

COMMIT;
