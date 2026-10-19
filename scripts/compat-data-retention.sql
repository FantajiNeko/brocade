-- Add editable TTL overrides to an existing Brocade database.
-- Stop Console writers before running. Restore-test first; run as the application owner.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL ROLE :"app_role";
SELECT pg_advisory_xact_lock(1481785689);

CREATE TABLE data_retention_policies (
    table_name TEXT NOT NULL,
    ttl_hours INTEGER NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_by TEXT NOT NULL,
    CONSTRAINT data_retention_policies_pkey PRIMARY KEY (table_name),
    CONSTRAINT data_retention_policies_ttl_range CHECK (ttl_hours >= 1 AND ttl_hours <= 87600),
    CONSTRAINT data_retention_policies_updated_by_fkey
        FOREIGN KEY (updated_by) REFERENCES admin_operators(id) ON DELETE RESTRICT
);

COMMIT;
