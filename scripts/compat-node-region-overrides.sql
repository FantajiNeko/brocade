-- Add durable manual machine-region corrections for existing databases. Stop Console writers,
-- take a backup, and run as the application owner before deploying the matching Console.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL ROLE :"app_role";
SELECT pg_advisory_xact_lock(1481785689);

CREATE TABLE node_region_overrides (
    node_id TEXT NOT NULL,
    country_code TEXT NOT NULL,
    selected_by TEXT NOT NULL,
    selected_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    CONSTRAINT node_region_overrides_pkey PRIMARY KEY (node_id),
    CONSTRAINT node_region_overrides_node_fkey FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE,
    CONSTRAINT node_region_overrides_country_shape CHECK (country_code ~ '^[A-Z]{2}$'),
    CONSTRAINT node_region_overrides_selected_by_shape CHECK (length(btrim(selected_by)) BETWEEN 1 AND 256)
);

COMMIT;
