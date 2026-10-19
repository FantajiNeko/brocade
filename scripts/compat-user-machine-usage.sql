-- Stop Console writers before running. Restore-test first; run as the application owner.
-- Does not change SQLx checksums. A second invocation fails safely instead of double counting.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL ROLE :"app_role";
SELECT pg_advisory_xact_lock(1481785689);
-- BEGIN USER MACHINE USAGE SCHEMA
-- Historical ingress attribution survives raw-window retention and later grant changes.
CREATE TABLE usage_user_node_rollups (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
    period_start TIMESTAMPTZ NOT NULL,
    uplink_bytes BIGINT NOT NULL CHECK (uplink_bytes >= 0),
    downlink_bytes BIGINT NOT NULL CHECK (downlink_bytes >= 0),
    has_gap BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (tenant_id, user_id, period_start, node_id),
    FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);
-- END USER MACHINE USAGE SCHEMA

INSERT INTO usage_user_node_rollups
    (tenant_id,user_id,node_id,period_start,uplink_bytes,downlink_bytes,has_gap)
SELECT tenant_id,user_id,node_id,
       date_trunc('day',window_start AT TIME ZONE 'Asia/Hong_Kong') AT TIME ZONE 'Asia/Hong_Kong',
       sum(uplink_bytes)::bigint,sum(downlink_bytes)::bigint,bool_or(has_gap)
FROM usage_samples WHERE app_id IS NOT NULL
GROUP BY tenant_id,user_id,node_id,4;
COMMIT;
