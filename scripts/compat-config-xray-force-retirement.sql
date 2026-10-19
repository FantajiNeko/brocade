-- Add the exact, auditable authorization used to end an old Xray configuration generation after
-- its drain deadline or before a newer executable configuration release. Stop Console writers and
-- back up before running this script. Verify the definition against 0001 before updating the SQLx
-- version-1 checksum.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE :"app_role";
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(1481785689);

CREATE TABLE config_xray_force_retirements (
    deployment_id BIGINT NOT NULL,
    node_id TEXT NOT NULL,
    claim_generation BIGINT NOT NULL,
    requested_by TEXT NOT NULL,
    requested_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    settled_at TIMESTAMPTZ,
    CONSTRAINT config_xray_force_retirements_claim_generation_check CHECK (claim_generation >= 0),
    CONSTRAINT config_xray_force_retirements_pkey PRIMARY KEY (deployment_id, node_id, claim_generation),
    CONSTRAINT config_xray_force_retirements_target_fkey
        FOREIGN KEY (deployment_id, node_id)
        REFERENCES deployment_targets(deployment_id, node_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX config_xray_force_retirements_one_active_per_node
    ON config_xray_force_retirements (node_id)
    WHERE settled_at IS NULL;

COMMIT;
