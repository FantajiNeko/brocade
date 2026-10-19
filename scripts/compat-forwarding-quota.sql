-- Stop Console writers, back up and rehearse against an isolated restored database first.
-- This creates no quota limits and changes no existing forwarding rule or counter.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SET LOCAL ROLE :"app_role";
-- BEGIN FORWARDING QUOTA SCHEMA
CREATE TABLE forwarding_node_quotas (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    limit_bytes BIGINT CHECK (limit_bytes > 0),
    suspended BOOLEAN DEFAULT false NOT NULL,
    last_job_id BIGINT REFERENCES jobs(id) ON DELETE RESTRICT,
    updated_by TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    PRIMARY KEY (tenant_id, user_id, node_id),
    FOREIGN KEY (tenant_id, user_id, node_id)
        REFERENCES forwarding_entitlements(tenant_id, user_id, node_id) ON DELETE CASCADE
);
CREATE INDEX forwarding_quota_jobs_by_owner ON jobs
    ((payload->>'tenant_id'), (payload->>'user_id'), (payload->>'node_id'), id DESC)
    WHERE kind='forwarding-quota';
CREATE INDEX forwarding_quota_jobs_pending_node ON jobs
    ((payload->>'node_id'), ((payload->>'generation')::bigint))
    WHERE kind='forwarding-quota' AND status IN ('queued','running');
-- END FORWARDING QUOTA SCHEMA
COMMIT;
-- Verify definitions/ownership and all other schema differences before separately updating SQLx.
