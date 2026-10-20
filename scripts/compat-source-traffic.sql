-- Stop Console writers and restore-test before running as the application owner.
-- Adds optional observation tables and range-query indexes; no historical IP attribution is fabricated.
-- Does not change SQLx checksums; a second invocation fails and rolls back.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL ROLE :"app_role";
SELECT pg_advisory_xact_lock(1481785689);
-- BEGIN SOURCE TRAFFIC SCHEMA
CREATE INDEX usage_samples_by_node_window_start ON usage_samples (node_id, window_start);
CREATE INDEX forwarding_usage_samples_by_node_window_start ON forwarding_usage_samples (node_id, window_start);
CREATE TABLE node_source_traffic_state (
    node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    epoch TEXT NOT NULL,
    read_at BIGINT NOT NULL CHECK (read_at > 0),
    observed_since BIGINT NOT NULL CHECK (observed_since > 0),
    limited BOOLEAN NOT NULL
);
CREATE TABLE source_traffic_windows (
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    epoch TEXT NOT NULL,
    bucket BIGINT NOT NULL CHECK (bucket > 0 AND bucket % 30 = 0),
    label TEXT NOT NULL CHECK (octet_length(label) <= 256),
    source_ip INET NOT NULL,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    app_id TEXT NOT NULL,
    chain_id TEXT NOT NULL,
    ingress_id TEXT NOT NULL,
    uplink_bytes BIGINT NOT NULL CHECK (uplink_bytes >= 0),
    downlink_bytes BIGINT NOT NULL CHECK (downlink_bytes >= 0),
    PRIMARY KEY (node_id, epoch, bucket, label, source_ip),
    FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX source_traffic_windows_by_node ON source_traffic_windows (node_id, bucket, tenant_id, user_id);
CREATE INDEX source_traffic_windows_by_bucket ON source_traffic_windows (bucket);
CREATE TABLE source_traffic_daily (
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    bucket BIGINT NOT NULL CHECK (bucket > 0),
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    app_id TEXT NOT NULL,
    chain_id TEXT NOT NULL,
    ingress_id TEXT NOT NULL,
    source_ip INET NOT NULL,
    uplink_bytes BIGINT NOT NULL CHECK (uplink_bytes >= 0),
    downlink_bytes BIGINT NOT NULL CHECK (downlink_bytes >= 0),
    PRIMARY KEY (node_id, bucket, tenant_id, user_id, app_id, chain_id, ingress_id, source_ip),
    FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX source_traffic_daily_by_bucket ON source_traffic_daily (bucket);
-- END SOURCE TRAFFIC SCHEMA
COMMIT;
