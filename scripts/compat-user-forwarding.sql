-- Additive compatibility for user-managed L4 forwarding on an existing Console database.
-- Stop old Console writers first, then run as the application role:
--   psql -X -v ON_ERROR_STOP=1 -d brocade -v app_role=brocade \
--     -f scripts/compat-user-forwarding.sql
--
-- Deliberately omit IF NOT EXISTS. A repeated or partially applied conversion must stop so an
-- operator inspects the schema instead of silently accepting an unknown state.

\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET LOCAL ROLE :"app_role";

CREATE TABLE forwarding_entitlements (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    tcp_allowed BOOLEAN DEFAULT true NOT NULL,
    udp_allowed BOOLEAN DEFAULT true NOT NULL,
    listen_port_start INTEGER DEFAULT 30000 NOT NULL,
    listen_port_end INTEGER DEFAULT 59999 NOT NULL,
    max_rules INTEGER DEFAULT 100 NOT NULL,
    allow_private_targets BOOLEAN DEFAULT true NOT NULL,
    enabled BOOLEAN DEFAULT true NOT NULL,
    updated_by TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    CONSTRAINT forwarding_entitlements_pkey PRIMARY KEY (tenant_id, user_id, node_id),
    CONSTRAINT forwarding_entitlements_user_fkey FOREIGN KEY (tenant_id, user_id)
        REFERENCES users(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT forwarding_entitlements_node_fkey FOREIGN KEY (node_id)
        REFERENCES nodes(id) ON DELETE RESTRICT,
    CONSTRAINT forwarding_entitlements_port_range CHECK (
        listen_port_start BETWEEN 1024 AND 65535
        AND listen_port_end BETWEEN listen_port_start AND 65535
    ),
    CONSTRAINT forwarding_entitlements_max_rules CHECK (max_rules BETWEEN 1 AND 256),
    CONSTRAINT forwarding_entitlements_protocol CHECK (tcp_allowed OR udp_allowed)
);

CREATE TABLE forwarding_node_state (
    node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    desired_generation BIGINT DEFAULT 0 NOT NULL,
    applied_generation BIGINT,
    reconcile_status TEXT DEFAULT 'pending' NOT NULL,
    applied_rule_ids JSONB DEFAULT '[]'::jsonb NOT NULL,
    last_error TEXT,
    reported_at TIMESTAMPTZ,
    CONSTRAINT forwarding_node_state_generation CHECK (desired_generation >= 0),
    CONSTRAINT forwarding_node_state_applied_generation CHECK (
        applied_generation IS NULL OR applied_generation >= 0
    ),
    CONSTRAINT forwarding_node_state_status CHECK (
        reconcile_status IN ('pending', 'converged', 'error')
    ),
    CONSTRAINT forwarding_node_state_applied_rules CHECK (jsonb_typeof(applied_rule_ids) = 'array')
);

CREATE TABLE forwarding_rules (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    name TEXT NOT NULL,
    protocol TEXT NOT NULL,
    listen_port INTEGER NOT NULL,
    target_host TEXT NOT NULL,
    target_port INTEGER NOT NULL,
    enabled BOOLEAN DEFAULT true NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    deleted_at TIMESTAMPTZ,
    CONSTRAINT forwarding_rules_user_fkey FOREIGN KEY (tenant_id, user_id)
        REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT forwarding_rules_node_fkey FOREIGN KEY (node_id)
        REFERENCES nodes(id) ON DELETE RESTRICT,
    CONSTRAINT forwarding_rules_protocol CHECK (protocol IN ('tcp', 'udp', 'tcp_udp')),
    CONSTRAINT forwarding_rules_listen_port CHECK (listen_port BETWEEN 1 AND 65535),
    CONSTRAINT forwarding_rules_target_port CHECK (target_port BETWEEN 1 AND 65535),
    CONSTRAINT forwarding_rules_name_shape CHECK (length(btrim(name)) BETWEEN 1 AND 80),
    CONSTRAINT forwarding_rules_target_shape CHECK (length(btrim(target_host)) BETWEEN 1 AND 253)
);

CREATE UNIQUE INDEX forwarding_rules_active_tcp_port
    ON forwarding_rules (node_id, listen_port)
    WHERE deleted_at IS NULL AND enabled AND protocol IN ('tcp', 'tcp_udp');
CREATE UNIQUE INDEX forwarding_rules_active_udp_port
    ON forwarding_rules (node_id, listen_port)
    WHERE deleted_at IS NULL AND enabled AND protocol IN ('udp', 'tcp_udp');
CREATE INDEX forwarding_rules_by_user
    ON forwarding_rules (tenant_id, user_id, created_at, id)
    WHERE deleted_at IS NULL;

CREATE TABLE forwarding_usage_report_receipts (
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
    agent_instance_id TEXT NOT NULL,
    sequence BIGINT NOT NULL,
    result JSONB NOT NULL,
    received_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    CONSTRAINT forwarding_usage_report_receipts_pkey
        PRIMARY KEY (node_id, agent_instance_id, sequence),
    CONSTRAINT forwarding_usage_report_receipts_sequence CHECK (sequence >= 0),
    CONSTRAINT forwarding_usage_report_receipts_result CHECK (jsonb_typeof(result) = 'object')
);

CREATE TABLE forwarding_usage_counter_heads (
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
    rule_id BIGINT NOT NULL REFERENCES forwarding_rules(id) ON DELETE RESTRICT,
    agent_instance_id TEXT NOT NULL,
    xray_epoch TEXT NOT NULL,
    uplink_bytes BIGINT NOT NULL,
    downlink_bytes BIGINT NOT NULL,
    read_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT forwarding_usage_counter_heads_pkey PRIMARY KEY (node_id, rule_id),
    CONSTRAINT forwarding_usage_counter_heads_uplink CHECK (uplink_bytes >= 0),
    CONSTRAINT forwarding_usage_counter_heads_downlink CHECK (downlink_bytes >= 0)
);

CREATE TABLE forwarding_usage_samples (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
    rule_id BIGINT NOT NULL REFERENCES forwarding_rules(id) ON DELETE RESTRICT,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    read_at TIMESTAMPTZ NOT NULL,
    uplink_bytes BIGINT NOT NULL,
    downlink_bytes BIGINT NOT NULL,
    CONSTRAINT forwarding_usage_samples_user_fkey FOREIGN KEY (tenant_id, user_id)
        REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT forwarding_usage_samples_uplink CHECK (uplink_bytes >= 0),
    CONSTRAINT forwarding_usage_samples_downlink CHECK (downlink_bytes >= 0)
);
CREATE INDEX forwarding_usage_samples_by_user
    ON forwarding_usage_samples (tenant_id, user_id, read_at DESC);

COMMIT;
