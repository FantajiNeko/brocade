-- Split the legacy combined VPN Gate catalogue/IP-intelligence Agent set into independent sets
-- and make the overall background-work switch default to off. Stop Console writers and back up
-- before running. This is not backward-compatible with the old Console schema.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL ROLE :"app_role";
SELECT pg_advisory_xact_lock(1481785689);

ALTER TABLE vpngate_intelligence_nodes RENAME TO vpngate_catalog_nodes;
ALTER TABLE vpngate_catalog_nodes
    RENAME CONSTRAINT vpngate_intelligence_nodes_pkey TO vpngate_catalog_nodes_pkey;
ALTER TABLE vpngate_catalog_nodes
    RENAME CONSTRAINT vpngate_intelligence_nodes_node_fkey TO vpngate_catalog_nodes_node_fkey;
ALTER TABLE vpngate_catalog_nodes
    RENAME CONSTRAINT vpngate_intelligence_nodes_selected_by_shape TO vpngate_catalog_nodes_selected_by_shape;
ALTER TABLE vpngate_catalog_nodes
    RENAME CONSTRAINT vpngate_intel_nodes_catalogue_generation_nonnegative TO vpngate_catalog_nodes_generation_nonnegative;
ALTER TABLE vpngate_catalog_nodes
    RENAME CONSTRAINT vpngate_intel_nodes_catalogue_lease_coherent TO vpngate_catalog_nodes_lease_coherent;
ALTER TABLE vpngate_catalog_nodes
    RENAME CONSTRAINT vpngate_intel_nodes_catalogue_active_run_fkey TO vpngate_catalog_nodes_active_run_fkey;
ALTER TABLE vpngate_catalog_nodes
    RENAME CONSTRAINT vpngate_intel_nodes_catalogue_success_run_fkey TO vpngate_catalog_nodes_success_run_fkey;

CREATE TABLE vpngate_intelligence_nodes (
    node_id TEXT NOT NULL,
    selected_by TEXT NOT NULL,
    selected_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    CONSTRAINT vpngate_intelligence_nodes_pkey PRIMARY KEY (node_id),
    CONSTRAINT vpngate_intelligence_nodes_node_fkey FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE,
    CONSTRAINT vpngate_intelligence_nodes_selected_by_shape CHECK (length(btrim(selected_by)) BETWEEN 1 AND 256)
);

-- Preserve the old combined selection in both new sets. Operators can make them diverge after the
-- new Console starts; the split itself never silently drops a worker assignment.
INSERT INTO vpngate_intelligence_nodes (node_id, selected_by, selected_at)
SELECT node_id, selected_by, selected_at
  FROM vpngate_catalog_nodes;

ALTER TABLE vpngate_catalog_state ALTER COLUMN enabled SET DEFAULT false;
UPDATE vpngate_catalog_state
   SET next_sync_at = CASE WHEN enabled THEN now() ELSE next_sync_at END,
       enabled = false,
       updated_at = now()
 WHERE id = TRUE;

COMMIT;
