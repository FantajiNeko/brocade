-- Run only after checking the deployed schema/checksum. This script does not update
-- _sqlx_migrations: use the SHA-384 of the exact 0001_init.sql included in the build.
-- Other pending workspace schema changes are deliberately not included here.
-- Invoke with:
--   psql -X -v ON_ERROR_STOP=1 -d brocade -v app_role=brocade \
--     -f scripts/compat-user-site-usage.sql
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL ROLE :"app_role";
SELECT pg_advisory_xact_lock(1481785689);
ALTER TABLE control_state ADD COLUMN site_usage_enabled BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE node_site_usage_state (
    node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    epoch TEXT NOT NULL,
    activation_id BIGINT NOT NULL DEFAULT 0 CHECK (activation_id >= 0),
    generation_id BIGINT NOT NULL,
    read_at BIGINT NOT NULL CHECK (read_at > 0),
    baseline_at BIGINT NOT NULL CHECK (baseline_at > 0 AND baseline_at <= read_at),
    limited BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE site_usage_counter_heads (
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    site_id TEXT NOT NULL,
    read_at BIGINT NOT NULL CHECK (read_at > 0),
    uplink_bytes BIGINT NOT NULL CHECK (uplink_bytes >= 0),
    downlink_bytes BIGINT NOT NULL CHECK (downlink_bytes >= 0),
    PRIMARY KEY (node_id, label, site_id)
);
CREATE TABLE user_site_usage_hourly (
    bucket BIGINT NOT NULL CHECK (bucket > 0 AND bucket % 3600 = 0),
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    site_id TEXT NOT NULL,
    uplink_bytes BIGINT NOT NULL CHECK (uplink_bytes >= 0),
    downlink_bytes BIGINT NOT NULL CHECK (downlink_bytes >= 0),
    PRIMARY KEY (bucket, node_id, tenant_id, user_id, site_id),
    FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX user_site_usage_hourly_by_user ON user_site_usage_hourly (tenant_id, user_id, bucket);
COMMIT;
