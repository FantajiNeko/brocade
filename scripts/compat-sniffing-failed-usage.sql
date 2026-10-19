-- Review the production checksum and all schema differences before applying.
-- Covers failed-sniff targets only; does not update _sqlx_migrations or enable collection.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL ROLE :"app_role";
SELECT pg_advisory_xact_lock(1481785689);
ALTER TABLE control_state ADD COLUMN sniffing_failed_policy JSONB NOT NULL DEFAULT '{"enabled":false,"top_n":128,"max_targets_per_user":1024,"node_capacity":4096,"report_interval_secs":30}'::jsonb;
CREATE TABLE node_sniffing_failed_state (
    node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    epoch TEXT NOT NULL,
    read_at BIGINT NOT NULL CHECK (read_at > 0),
    observed_since BIGINT NOT NULL CHECK (observed_since > 0),
    limited BOOLEAN NOT NULL
);
CREATE TABLE sniffing_failed_counter_heads (
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    epoch TEXT NOT NULL,
    bucket BIGINT NOT NULL CHECK (bucket > 0 AND bucket % 3600 = 0),
    label TEXT NOT NULL CHECK (octet_length(label) <= 256),
    target TEXT NOT NULL CHECK (octet_length(target) <= 80),
    uplink_bytes BIGINT NOT NULL CHECK (uplink_bytes >= 0),
    downlink_bytes BIGINT NOT NULL CHECK (downlink_bytes >= 0),
    PRIMARY KEY (node_id, epoch, bucket, label, target)
);
CREATE INDEX sniffing_failed_heads_by_bucket ON sniffing_failed_counter_heads (bucket);
CREATE TABLE user_sniffing_failed_hourly (
    bucket BIGINT NOT NULL CHECK (bucket > 0 AND bucket % 3600 = 0),
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    target TEXT NOT NULL CHECK (octet_length(target) <= 80),
    uplink_bytes BIGINT NOT NULL CHECK (uplink_bytes >= 0),
    downlink_bytes BIGINT NOT NULL CHECK (downlink_bytes >= 0),
    PRIMARY KEY (bucket, node_id, tenant_id, user_id, target),
    FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX user_sniffing_failed_by_user ON user_sniffing_failed_hourly (tenant_id, user_id, bucket);
CREATE INDEX user_sniffing_failed_by_bucket ON user_sniffing_failed_hourly (bucket);
CREATE INDEX user_sniffing_failed_by_node ON user_sniffing_failed_hourly (node_id, bucket);
COMMIT;
