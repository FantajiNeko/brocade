-- Review deployed schema and checksum first. This does not update _sqlx_migrations.
-- Use the SHA-384 of the exact build's 0001_init.sql after verifying ALL schema differences.
-- Only the optional other-domain feature is covered; not other pending workspace changes.
-- psql -X -v ON_ERROR_STOP=1 -v app_role=brocade -d brocade -f scripts/compat-other-domain-usage.sql
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL ROLE :"app_role";
SELECT pg_advisory_xact_lock(1481785689);
ALTER TABLE control_state ADD COLUMN other_domain_policy JSONB NOT NULL DEFAULT '{"enabled":false,"top_n":128,"max_domains_per_user":1024,"node_capacity":4096,"report_interval_secs":30}'::jsonb;
CREATE TABLE node_other_domain_state (
    node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    epoch TEXT NOT NULL,
    read_at BIGINT NOT NULL CHECK (read_at > 0),
    observed_since BIGINT NOT NULL CHECK (observed_since > 0),
    limited BOOLEAN NOT NULL
);
CREATE TABLE other_domain_counter_heads (
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    epoch TEXT NOT NULL,
    bucket BIGINT NOT NULL CHECK (bucket > 0 AND bucket % 3600 = 0),
    label TEXT NOT NULL CHECK (octet_length(label) <= 256),
    domain TEXT NOT NULL CHECK (octet_length(domain) <= 253),
    uplink_bytes BIGINT NOT NULL CHECK (uplink_bytes >= 0),
    downlink_bytes BIGINT NOT NULL CHECK (downlink_bytes >= 0),
    PRIMARY KEY (node_id, epoch, bucket, label, domain)
);
CREATE INDEX other_domain_heads_by_bucket ON other_domain_counter_heads (bucket);
CREATE TABLE user_other_domain_hourly (
    bucket BIGINT NOT NULL CHECK (bucket > 0 AND bucket % 3600 = 0),
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    domain TEXT NOT NULL CHECK (octet_length(domain) <= 253),
    uplink_bytes BIGINT NOT NULL CHECK (uplink_bytes >= 0),
    downlink_bytes BIGINT NOT NULL CHECK (downlink_bytes >= 0),
    PRIMARY KEY (bucket, node_id, tenant_id, user_id, domain),
    FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX user_other_domain_by_user ON user_other_domain_hourly (tenant_id, user_id, bucket);
CREATE INDEX user_other_domain_by_bucket ON user_other_domain_hourly (bucket);
CREATE INDEX user_other_domain_by_node ON user_other_domain_hourly (node_id, bucket);
COMMIT;
