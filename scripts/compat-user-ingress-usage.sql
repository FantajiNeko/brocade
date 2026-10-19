-- Stop Console writers before running. Restore-test first; run as the application owner.
-- Does not change SQLx checksums. A second invocation fails safely instead of double counting.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL ROLE :"app_role";
SELECT pg_advisory_xact_lock(1481785689);
-- BEGIN USER INGRESS USAGE SCHEMA
-- A machine's inflow by access chain: user traffic per ingress and +08 day, accumulated in the
-- transaction that accepts the accounting window. The chain is frozen from the ingress at insert,
-- like usage_samples.app_id, so history keeps its attribution after the model moves on; NULL only
-- when the ingress was already gone. Keyed by machine first: every read is one machine's period.
CREATE TABLE usage_user_ingress_rollups (
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
    period_start TIMESTAMPTZ NOT NULL,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    ingress_id TEXT NOT NULL,
    app_id TEXT NOT NULL,
    chain_id TEXT,
    uplink_bytes BIGINT NOT NULL CHECK (uplink_bytes >= 0),
    downlink_bytes BIGINT NOT NULL CHECK (downlink_bytes >= 0),
    has_gap BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (node_id, period_start, tenant_id, user_id, ingress_id),
    FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);
-- The machine's outflow card reads one machine's hours across every user.
CREATE INDEX user_site_usage_hourly_by_node ON user_site_usage_hourly (node_id, bucket);
-- END USER INGRESS USAGE SCHEMA

-- Backfill only what the retained detail can prove. Days older than the detail retention stay in
-- usage_user_node_rollups and are reported as not attributed to a chain; they are not estimated.
-- An ingress that changed view within a day keeps that day's first view, as the live upsert does.
INSERT INTO usage_user_ingress_rollups
    (node_id,period_start,tenant_id,user_id,ingress_id,app_id,chain_id,uplink_bytes,downlink_bytes,has_gap)
SELECT s.node_id,
       date_trunc('day',s.window_start AT TIME ZONE 'Asia/Hong_Kong') AT TIME ZONE 'Asia/Hong_Kong',
       s.tenant_id,s.user_id,s.ingress_id,(array_agg(s.app_id ORDER BY s.window_start))[1],i.chain_id,
       sum(s.uplink_bytes)::bigint,sum(s.downlink_bytes)::bigint,bool_or(s.has_gap)
FROM usage_samples s LEFT JOIN ingresses i ON i.id=s.ingress_id
WHERE s.app_id IS NOT NULL
GROUP BY s.node_id,2,s.tenant_id,s.user_id,s.ingress_id,i.chain_id;
COMMIT;
