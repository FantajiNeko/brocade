-- Stop Console writers and back up before running as the application role. Extract the
-- FORWARDING TRAFFIC PROJECTIONS block from the exact target 0001 into schema_file.
-- psql -X -v ON_ERROR_STOP=1 -v app_role=brocade -v schema_file=/verified/forwarding.sql
-- This is a single audited conversion, not an idempotent guess at a partial schema.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET LOCAL ROLE :"app_role";
ALTER TABLE forwarding_usage_report_receipts ADD COLUMN payload_sha256 TEXT;
ALTER TABLE forwarding_usage_counter_heads ADD COLUMN sequence BIGINT;
ALTER TABLE forwarding_usage_counter_heads ADD COLUMN has_gap BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE forwarding_usage_samples ADD COLUMN window_start TIMESTAMPTZ;
ALTER TABLE forwarding_usage_samples ADD COLUMN has_gap BOOLEAN DEFAULT false NOT NULL;
\i :schema_file
INSERT INTO forwarding_rule_nodes (rule_id,node_id,assigned_at)
SELECT rule_id,node_id,min(assigned_at) FROM (
  SELECT id AS rule_id,node_id,created_at AS assigned_at FROM forwarding_rules
  UNION ALL
  SELECT rule_id,node_id,read_at FROM forwarding_usage_samples
  UNION ALL
  SELECT rule_id,node_id,read_at FROM forwarding_usage_counter_heads
) assignments GROUP BY rule_id,node_id
ON CONFLICT (rule_id,node_id) DO UPDATE SET assigned_at=LEAST(forwarding_rule_nodes.assigned_at,EXCLUDED.assigned_at);
-- Existing bytes are authoritative, but their interval was never stored. Preserve NULL start;
-- do not invent zero coverage or a one-second rate. Legacy daily attribution uses read_at.
INSERT INTO forwarding_usage_rollups
    (period_start,node_id,tenant_id,user_id,rule_id,uplink_bytes,downlink_bytes,has_gap)
SELECT date_trunc('day',read_at AT TIME ZONE 'Asia/Hong_Kong') AT TIME ZONE 'Asia/Hong_Kong',
       node_id,tenant_id,user_id,rule_id,sum(uplink_bytes),sum(downlink_bytes),bool_or(has_gap)
FROM forwarding_usage_samples GROUP BY 1,2,3,4,5;
DO $$ BEGIN
  IF (SELECT coalesce(sum(uplink_bytes+downlink_bytes),0) FROM forwarding_usage_samples)
     <> (SELECT coalesce(sum(uplink_bytes+downlink_bytes),0) FROM forwarding_usage_rollups) THEN
    RAISE EXCEPTION 'forwarding backfill byte totals differ';
  END IF;
END $$;
-- Verify ownership and every other 0001 difference before updating the SQLx checksum separately.
COMMIT;
