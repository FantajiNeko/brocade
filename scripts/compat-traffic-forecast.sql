-- Additive compatibility for daily machine traffic forecasts on an existing Console database.
-- Stop old Console writers first, then run as the application role:
--   psql -X -v ON_ERROR_STOP=1 -d brocade -v app_role=brocade \
--     -f scripts/compat-traffic-forecast.sql
--
-- Deliberately omit IF NOT EXISTS. A repeated or partially applied conversion must stop so an
-- operator inspects the schema instead of silently accepting an unknown state.

\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET LOCAL ROLE :"app_role";

CREATE TABLE node_traffic_forecasts (
    node_id TEXT NOT NULL,
    day DATE NOT NULL,
    taken_at TIMESTAMPTZ NOT NULL,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    quota_bytes NUMERIC(20,0),
    used_bytes NUMERIC(20,0) NOT NULL,
    p50_bytes NUMERIC(20,0) NOT NULL,
    p90_bytes NUMERIC(20,0) NOT NULL,
    CONSTRAINT node_traffic_forecasts_pkey PRIMARY KEY (node_id, day),
    CONSTRAINT node_traffic_forecasts_node_fkey FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE,
    CONSTRAINT node_traffic_forecasts_period CHECK (period_end > period_start),
    CONSTRAINT node_traffic_forecasts_quota_positive CHECK (quota_bytes IS NULL OR quota_bytes > 0),
    CONSTRAINT node_traffic_forecasts_ordered CHECK (
        used_bytes >= 0 AND p50_bytes >= used_bytes AND p90_bytes >= p50_bytes
    )
);

COMMIT;
