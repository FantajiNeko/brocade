-- Defaults affect new control-state rows only. Never re-enable an operator's saved opt-out.
BEGIN;
ALTER TABLE control_state ALTER COLUMN site_usage_enabled SET DEFAULT TRUE;
ALTER TABLE control_state ALTER COLUMN other_domain_policy SET DEFAULT
    '{"enabled":true,"top_n":128,"max_domains_per_user":1024,"node_capacity":4096,"report_interval_secs":30}'::jsonb;
ALTER TABLE control_state ALTER COLUMN sniffing_failed_policy SET DEFAULT
    '{"enabled":true,"top_n":128,"max_targets_per_user":1024,"node_capacity":4096,"report_interval_secs":30}'::jsonb;
COMMIT;
-- Reconcile version 1's migration checksum only after reviewing every pending schema change.
