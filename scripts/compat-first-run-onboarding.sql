-- Compatibility schema for the guided first-run flow.
--
-- Existing installations intentionally receive no row. A missing row means "not applicable", so
-- applying this script cannot redirect an established Console into onboarding. Fresh installs add
-- their singleton row atomically from `init_system`.
CREATE TABLE IF NOT EXISTS first_run_onboarding (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    root_tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    started_by TEXT NOT NULL REFERENCES admin_operators(id) ON DELETE RESTRICT,
    started_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
    app_id TEXT REFERENCES apps(id) ON UPDATE CASCADE ON DELETE SET NULL,
    chain_id TEXT REFERENCES chains(id) ON UPDATE CASCADE ON DELETE SET NULL,
    ingress_id TEXT REFERENCES ingresses(id) ON UPDATE CASCADE ON DELETE SET NULL,
    user_tenant_id TEXT,
    user_id TEXT,
    target_revision_id BIGINT REFERENCES revisions(id) ON DELETE RESTRICT,
    deployment_id BIGINT REFERENCES deployments(id) ON DELETE RESTRICT,
    completed_at TIMESTAMPTZ,
    completed_by TEXT REFERENCES admin_operators(id) ON DELETE RESTRICT,
    probe_id TEXT,
    probe_item_id TEXT,
    probe_serving_generation BIGINT,
    probe_protocol TEXT,
    probe_family TEXT,
    FOREIGN KEY (user_tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL,
    CHECK ((user_tenant_id IS NULL) = (user_id IS NULL)),
    CHECK (
        completed_at IS NOT NULL
        OR (app_id IS NULL AND chain_id IS NULL AND ingress_id IS NULL
            AND user_tenant_id IS NULL AND user_id IS NULL AND target_revision_id IS NULL)
        OR
        (app_id IS NOT NULL AND chain_id IS NOT NULL AND ingress_id IS NOT NULL
            AND user_tenant_id IS NOT NULL AND user_id IS NOT NULL AND target_revision_id IS NOT NULL)
    ),
    CHECK (
        (completed_at IS NULL AND completed_by IS NULL AND probe_id IS NULL
            AND probe_item_id IS NULL AND probe_serving_generation IS NULL
            AND probe_protocol IS NULL AND probe_family IS NULL)
        OR
        (completed_at IS NOT NULL AND completed_by IS NOT NULL AND probe_id IS NOT NULL
            AND probe_item_id IS NOT NULL AND probe_serving_generation IS NOT NULL
            AND probe_protocol IS NOT NULL AND probe_family IS NOT NULL)
    )
);
