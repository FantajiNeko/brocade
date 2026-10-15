-- Additive compatibility for machine traffic capacity modelling on an existing Console database.
-- Stop old Console writers first, then run as the application role:
--   psql -X -v ON_ERROR_STOP=1 -d brocade -v app_role=brocade \
--     -f scripts/compat-traffic-capacity.sql
--
-- Deliberately omit IF NOT EXISTS. A repeated or partially applied conversion must stop so an
-- operator inspects the schema instead of silently accepting an unknown state.

\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET LOCAL ROLE :"app_role";

ALTER TABLE node_traffic_policy
    ADD COLUMN quota_bytes NUMERIC(20,0),
    ADD CONSTRAINT node_traffic_policy_quota_bytes_positive
        CHECK (quota_bytes IS NULL OR quota_bytes > 0);

COMMIT;
