-- Align an existing user-managed forwarding schema with the current defaults for new grants.
-- Stop Console writers first, then run as the application role:
--   psql -X -v ON_ERROR_STOP=1 -d brocade -v app_role=brocade \
--     -f scripts/compat-forwarding-entitlement-defaults.sql
--
-- This changes column defaults only. Existing entitlements retain their reviewed policy.

\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';
SET LOCAL ROLE :"app_role";

ALTER TABLE forwarding_entitlements
    ALTER COLUMN tcp_allowed SET DEFAULT true,
    ALTER COLUMN udp_allowed SET DEFAULT true,
    ALTER COLUMN listen_port_start SET DEFAULT 30000,
    ALTER COLUMN listen_port_end SET DEFAULT 59999,
    ALTER COLUMN max_rules SET DEFAULT 100,
    ALTER COLUMN allow_private_targets SET DEFAULT true;

COMMIT;
