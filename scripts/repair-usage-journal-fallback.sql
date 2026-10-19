-- Run inside a transaction after loading the independently reviewed temporary correction_plan.
-- Required psql variables: repair_id, plan_sha256, expected_entries, expected_up, expected_down.
-- This administrative audit schema is owned by the operator, outside the application's schema.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('brocade-usage-journal-correction', 0));
SELECT set_config('brocade.repair_id', :'repair_id', true),
       set_config('brocade.plan_sha256', :'plan_sha256', true),
       set_config('brocade.expected_entries', :'expected_entries', true),
       set_config('brocade.expected_up', :'expected_up', true),
       set_config('brocade.expected_down', :'expected_down', true);

CREATE SCHEMA IF NOT EXISTS brocade_repair AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA brocade_repair FROM PUBLIC;
CREATE TABLE IF NOT EXISTS brocade_repair.usage_correction_batches (
    id text PRIMARY KEY,
    plan_sha256 text NOT NULL CHECK (length(plan_sha256) = 64),
    evidence jsonb NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON brocade_repair.usage_correction_batches FROM PUBLIC;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM brocade_repair.usage_correction_batches
               WHERE id=current_setting('brocade.repair_id')) THEN
        RAISE EXCEPTION 'correction already applied; refusing a second subtraction';
    END IF;
END $$;

-- Stop concurrent projection increments only for this bounded transaction. Do not stop Xray.
LOCK TABLE usage_samples, usage_chain_samples, usage_rollups, usage_node_rollups,
    usage_node_windows, usage_user_node_rollups, usage_user_ingress_rollups
    IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE corrected_users AS
SELECT s.*, c.subtract_up, c.subtract_down, c.real_up, c.real_down,
       c.reading_id, c.previous_reading_id,
       p.generation_id IS DISTINCT FROM r.generation_id AS corrected_gap
FROM correction_plan c
JOIN usage_readings r ON r.id=c.reading_id AND r.node_id=c.node AND r.label=c.label
    AND r.generation_id=c.generation AND r.read_at=to_timestamp(c.window_end)
    AND r.uplink_bytes=c.original_up AND r.downlink_bytes=c.original_down
JOIN usage_readings p ON p.id=c.previous_reading_id AND p.node_id=c.node AND p.label=c.label
    AND p.uplink_bytes=c.subtract_up AND p.downlink_bytes=c.subtract_down
JOIN usage_samples s ON s.node_id=c.node AND s.generation_id=c.generation
    AND s.grant_label=c.label AND s.window_start=to_timestamp(c.window_start)
    AND s.window_end=to_timestamp(c.window_end)
    AND s.uplink_bytes=c.original_up AND s.downlink_bytes=c.original_down AND s.has_gap;
CREATE TEMP TABLE corrected_relays AS
SELECT s.*, c.subtract_up, c.subtract_down, c.real_up, c.real_down,
       c.reading_id, c.previous_reading_id,
       p.generation_id IS DISTINCT FROM r.generation_id AS corrected_gap
FROM correction_plan c
JOIN usage_readings r ON r.id=c.reading_id AND r.node_id=c.node AND r.label=c.label
    AND r.generation_id=c.generation AND r.read_at=to_timestamp(c.window_end)
    AND r.uplink_bytes=c.original_up AND r.downlink_bytes=c.original_down
JOIN usage_readings p ON p.id=c.previous_reading_id AND p.node_id=c.node AND p.label=c.label
    AND p.uplink_bytes=c.subtract_up AND p.downlink_bytes=c.subtract_down
JOIN usage_chain_samples s ON s.generation_id=c.generation AND s.hop_label=c.label
    AND s.window_start=to_timestamp(c.window_start) AND s.window_end=to_timestamp(c.window_end)
    AND s.uplink_bytes=c.original_up AND s.downlink_bytes=c.original_down AND s.has_gap;

DO $$ BEGIN
    IF (SELECT count(*) FROM corrected_users)+(SELECT count(*) FROM corrected_relays)
        <> current_setting('brocade.expected_entries')::bigint
        OR (SELECT count(*) FROM correction_plan) <> current_setting('brocade.expected_entries')::bigint
        OR EXISTS (SELECT 1 FROM correction_plan WHERE real_up<0 OR real_down<0
                    OR original_up-subtract_up<>real_up OR original_down-subtract_down<>real_down)
        OR (SELECT coalesce(sum(subtract_up),0) FROM correction_plan) <> current_setting('brocade.expected_up')::numeric
        OR (SELECT coalesce(sum(subtract_down),0) FROM correction_plan) <> current_setting('brocade.expected_down')::numeric THEN
        RAISE EXCEPTION 'plan, readings, exact samples or expected totals changed';
    END IF;
    IF EXISTS (SELECT 1 FROM corrected_users WHERE app_id IS NULL) THEN
        RAISE EXCEPTION 'unattributed application requires separate review';
    END IF;
    -- Gap flags can be rebuilt only while every sample for each touched day remains retained.
    IF EXISTS (SELECT 1 FROM (
        SELECT window_start,'usage_samples' AS source FROM corrected_users
        UNION ALL SELECT window_start,'usage_chain_samples' FROM corrected_relays
    ) s WHERE date_trunc('day',window_start AT TIME ZONE 'Asia/Hong_Kong') AT TIME ZONE 'Asia/Hong_Kong'
        < now()-make_interval(hours => coalesce((SELECT ttl_hours FROM data_retention_policies WHERE table_name=s.source),168))) THEN
        RAISE EXCEPTION 'day no longer fully retained; preserve gap flags in a separately reviewed plan';
    END IF;
END $$;

CREATE TEMP TABLE user_days AS
SELECT tenant_id,user_id,app_id,
    date_trunc('day',window_start AT TIME ZONE 'Asia/Hong_Kong') AT TIME ZONE 'Asia/Hong_Kong' AS day,
    sum(subtract_up)::bigint AS up,sum(subtract_down)::bigint AS down
FROM corrected_users GROUP BY 1,2,3,4;
CREATE TEMP TABLE machine_days AS
SELECT tenant_id,user_id,node_id,
    date_trunc('day',window_start AT TIME ZONE 'Asia/Hong_Kong') AT TIME ZONE 'Asia/Hong_Kong' AS day,
    sum(subtract_up)::bigint AS up,sum(subtract_down)::bigint AS down
FROM corrected_users GROUP BY 1,2,3,4;
CREATE TEMP TABLE ingress_days AS
SELECT tenant_id,user_id,node_id,ingress_id,
    date_trunc('day',window_start AT TIME ZONE 'Asia/Hong_Kong') AT TIME ZONE 'Asia/Hong_Kong' AS day,
    sum(subtract_up)::bigint AS up,sum(subtract_down)::bigint AS down
FROM corrected_users GROUP BY 1,2,3,4,5;
CREATE TEMP TABLE node_deltas AS
SELECT tenant_id,node_id,window_start,window_end,subtract_up AS user_up,subtract_down AS user_down,
    0::bigint AS relay_up,0::bigint AS relay_down FROM corrected_users
UNION ALL SELECT tenant_id,node_id,window_start,window_end,0,0,subtract_up,subtract_down FROM corrected_relays;
CREATE TEMP TABLE node_days AS
SELECT tenant_id,node_id,
    date_trunc('day',window_start AT TIME ZONE 'Asia/Hong_Kong') AT TIME ZONE 'Asia/Hong_Kong' AS day,
    sum(user_up)::bigint AS user_up,sum(user_down)::bigint AS user_down,
    sum(relay_up)::bigint AS relay_up,sum(relay_down)::bigint AS relay_down
FROM node_deltas GROUP BY 1,2,3;
CREATE TEMP TABLE node_windows AS
SELECT tenant_id,node_id,window_end,sum(user_up)::bigint AS user_up,sum(user_down)::bigint AS user_down,
    sum(relay_up)::bigint AS relay_up,sum(relay_down)::bigint AS relay_down
FROM node_deltas GROUP BY 1,2,3;

CREATE TEMP TABLE repair_before (kind text NOT NULL, row_data jsonb NOT NULL);
INSERT INTO repair_before SELECT 'usage_samples',to_jsonb(s) FROM usage_samples s JOIN corrected_users c USING(id);
INSERT INTO repair_before SELECT 'usage_chain_samples',to_jsonb(s) FROM usage_chain_samples s JOIN corrected_relays c USING(id);
INSERT INTO repair_before SELECT 'usage_rollups',to_jsonb(s) FROM usage_rollups s JOIN user_days c
    ON (s.tenant_id,s.user_id,s.app_id,s.period_start)=(c.tenant_id,c.user_id,c.app_id,c.day);
INSERT INTO repair_before SELECT 'usage_user_node_rollups',to_jsonb(s) FROM usage_user_node_rollups s JOIN machine_days c
    ON (s.tenant_id,s.user_id,s.node_id,s.period_start)=(c.tenant_id,c.user_id,c.node_id,c.day);
INSERT INTO repair_before SELECT 'usage_user_ingress_rollups',to_jsonb(s) FROM usage_user_ingress_rollups s JOIN ingress_days c
    ON (s.tenant_id,s.user_id,s.node_id,s.ingress_id,s.period_start)=(c.tenant_id,c.user_id,c.node_id,c.ingress_id,c.day);
INSERT INTO repair_before SELECT 'usage_node_rollups',to_jsonb(s) FROM usage_node_rollups s JOIN node_days c
    ON (s.tenant_id,s.node_id,s.period_start)=(c.tenant_id,c.node_id,c.day);
INSERT INTO repair_before SELECT 'usage_node_windows',to_jsonb(s) FROM usage_node_windows s JOIN node_windows c
    ON (s.tenant_id,s.node_id,s.window_end)=(c.tenant_id,c.node_id,c.window_end);

-- Subtract deltas from the live totals; never replace a total from an earlier snapshot.
UPDATE usage_samples s SET uplink_bytes=c.real_up,downlink_bytes=c.real_down,has_gap=c.corrected_gap
FROM corrected_users c WHERE s.id=c.id;
UPDATE usage_chain_samples s SET uplink_bytes=c.real_up,downlink_bytes=c.real_down,has_gap=c.corrected_gap
FROM corrected_relays c WHERE s.id=c.id;
UPDATE usage_rollups s SET uplink_bytes=s.uplink_bytes-c.up,downlink_bytes=s.downlink_bytes-c.down,
    has_gap=coalesce((SELECT bool_or(a.has_gap) FROM usage_samples a
        WHERE (a.tenant_id,a.user_id,a.app_id)=(s.tenant_id,s.user_id,s.app_id)
        AND a.window_start>=c.day AND a.window_start<c.day+interval '1 day'),false),updated_at=now()
FROM user_days c WHERE (s.tenant_id,s.user_id,s.app_id,s.period_start)=(c.tenant_id,c.user_id,c.app_id,c.day);
UPDATE usage_user_node_rollups s SET uplink_bytes=s.uplink_bytes-c.up,downlink_bytes=s.downlink_bytes-c.down,
    has_gap=coalesce((SELECT bool_or(a.has_gap) FROM usage_samples a
        WHERE (a.tenant_id,a.user_id,a.node_id)=(s.tenant_id,s.user_id,s.node_id)
        AND a.window_start>=c.day AND a.window_start<c.day+interval '1 day'),false)
FROM machine_days c WHERE (s.tenant_id,s.user_id,s.node_id,s.period_start)=(c.tenant_id,c.user_id,c.node_id,c.day);
UPDATE usage_user_ingress_rollups s SET uplink_bytes=s.uplink_bytes-c.up,downlink_bytes=s.downlink_bytes-c.down,
    has_gap=coalesce((SELECT bool_or(a.has_gap) FROM usage_samples a
        WHERE (a.tenant_id,a.user_id,a.node_id,a.ingress_id)=(s.tenant_id,s.user_id,s.node_id,s.ingress_id)
        AND a.window_start>=c.day AND a.window_start<c.day+interval '1 day'),false)
FROM ingress_days c WHERE (s.tenant_id,s.user_id,s.node_id,s.ingress_id,s.period_start)=(c.tenant_id,c.user_id,c.node_id,c.ingress_id,c.day);
UPDATE usage_node_rollups s SET user_uplink_bytes=s.user_uplink_bytes-c.user_up,
    user_downlink_bytes=s.user_downlink_bytes-c.user_down,relay_uplink_bytes=s.relay_uplink_bytes-c.relay_up,
    relay_downlink_bytes=s.relay_downlink_bytes-c.relay_down,
    has_gap=coalesce((SELECT bool_or(gap) FROM (
        SELECT has_gap AS gap FROM usage_samples a WHERE (a.tenant_id,a.node_id)=(s.tenant_id,s.node_id)
            AND a.window_start>=c.day AND a.window_start<c.day+interval '1 day'
        UNION ALL SELECT has_gap FROM usage_chain_samples a WHERE (a.tenant_id,a.node_id)=(s.tenant_id,s.node_id)
            AND a.window_start>=c.day AND a.window_start<c.day+interval '1 day') gaps),false),updated_at=now()
FROM node_days c WHERE (s.tenant_id,s.node_id,s.period_start)=(c.tenant_id,c.node_id,c.day);
UPDATE usage_node_windows s SET user_uplink_bytes=s.user_uplink_bytes-c.user_up,
    user_downlink_bytes=s.user_downlink_bytes-c.user_down,relay_uplink_bytes=s.relay_uplink_bytes-c.relay_up,
    relay_downlink_bytes=s.relay_downlink_bytes-c.relay_down
FROM node_windows c WHERE (s.tenant_id,s.node_id,s.window_end)=(c.tenant_id,c.node_id,c.window_end);

-- An absent projection or mismatched ownership aborts the entire transaction.
DO $$ DECLARE item record; actual bigint; BEGIN
    FOR item IN SELECT 'usage_rollups' AS kind,count(*) AS expected FROM user_days
        UNION ALL SELECT 'usage_user_node_rollups',count(*) FROM machine_days
        UNION ALL SELECT 'usage_user_ingress_rollups',count(*) FROM ingress_days
        UNION ALL SELECT 'usage_node_rollups',count(*) FROM node_days
        UNION ALL SELECT 'usage_node_windows',count(*) FROM node_windows
    LOOP
        SELECT count(*) INTO actual FROM repair_before WHERE kind=item.kind;
        IF actual<>item.expected THEN RAISE EXCEPTION 'projection % missing or duplicated',item.kind; END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM usage_samples s JOIN corrected_users c USING(id)
        WHERE (s.uplink_bytes,s.downlink_bytes,s.has_gap) IS DISTINCT FROM (c.real_up,c.real_down,c.corrected_gap))
       OR EXISTS(SELECT 1 FROM usage_chain_samples s JOIN corrected_relays c USING(id)
        WHERE (s.uplink_bytes,s.downlink_bytes,s.has_gap) IS DISTINCT FROM (c.real_up,c.real_down,c.corrected_gap)) THEN
        RAISE EXCEPTION 'real byte preservation failed';
    END IF;
    IF EXISTS(SELECT 1 FROM usage_rollups s JOIN user_days c
        ON (s.tenant_id,s.user_id,s.app_id,s.period_start)=(c.tenant_id,c.user_id,c.app_id,c.day)
        WHERE (s.uplink_bytes,s.downlink_bytes) IS DISTINCT FROM
        (SELECT ROW(coalesce(sum(a.uplink_bytes),0)::bigint,coalesce(sum(a.downlink_bytes),0)::bigint)
         FROM usage_samples a WHERE (a.tenant_id,a.user_id,a.app_id)=(s.tenant_id,s.user_id,s.app_id)
         AND a.window_start>=c.day AND a.window_start<c.day+interval '1 day'))
    OR EXISTS(SELECT 1 FROM usage_user_node_rollups s JOIN machine_days c
        ON (s.tenant_id,s.user_id,s.node_id,s.period_start)=(c.tenant_id,c.user_id,c.node_id,c.day)
        WHERE (s.uplink_bytes,s.downlink_bytes) IS DISTINCT FROM
        (SELECT ROW(coalesce(sum(a.uplink_bytes),0)::bigint,coalesce(sum(a.downlink_bytes),0)::bigint)
         FROM usage_samples a WHERE (a.tenant_id,a.user_id,a.node_id)=(s.tenant_id,s.user_id,s.node_id)
         AND a.window_start>=c.day AND a.window_start<c.day+interval '1 day'))
    OR EXISTS(SELECT 1 FROM usage_user_ingress_rollups s JOIN ingress_days c
        ON (s.tenant_id,s.user_id,s.node_id,s.ingress_id,s.period_start)=(c.tenant_id,c.user_id,c.node_id,c.ingress_id,c.day)
        WHERE (s.uplink_bytes,s.downlink_bytes) IS DISTINCT FROM
        (SELECT ROW(coalesce(sum(a.uplink_bytes),0)::bigint,coalesce(sum(a.downlink_bytes),0)::bigint)
         FROM usage_samples a WHERE (a.tenant_id,a.user_id,a.node_id,a.ingress_id)=(s.tenant_id,s.user_id,s.node_id,s.ingress_id)
         AND a.window_start>=c.day AND a.window_start<c.day+interval '1 day')) THEN
        RAISE EXCEPTION 'user projections disagree with retained day samples';
    END IF;
    IF EXISTS(SELECT 1 FROM usage_node_rollups s JOIN node_days c
        ON (s.tenant_id,s.node_id,s.period_start)=(c.tenant_id,c.node_id,c.day)
        WHERE (s.user_uplink_bytes,s.user_downlink_bytes,s.relay_uplink_bytes,s.relay_downlink_bytes)
        IS DISTINCT FROM (SELECT ROW(
            coalesce((SELECT sum(a.uplink_bytes)::bigint FROM usage_samples a WHERE (a.tenant_id,a.node_id)=(s.tenant_id,s.node_id) AND a.window_start>=c.day AND a.window_start<c.day+interval '1 day'),0),
            coalesce((SELECT sum(a.downlink_bytes)::bigint FROM usage_samples a WHERE (a.tenant_id,a.node_id)=(s.tenant_id,s.node_id) AND a.window_start>=c.day AND a.window_start<c.day+interval '1 day'),0),
            coalesce((SELECT sum(a.uplink_bytes)::bigint FROM usage_chain_samples a WHERE (a.tenant_id,a.node_id)=(s.tenant_id,s.node_id) AND a.window_start>=c.day AND a.window_start<c.day+interval '1 day'),0),
            coalesce((SELECT sum(a.downlink_bytes)::bigint FROM usage_chain_samples a WHERE (a.tenant_id,a.node_id)=(s.tenant_id,s.node_id) AND a.window_start>=c.day AND a.window_start<c.day+interval '1 day'),0))))
    OR EXISTS(SELECT 1 FROM usage_node_windows s JOIN node_windows c
        ON (s.tenant_id,s.node_id,s.window_end)=(c.tenant_id,c.node_id,c.window_end)
        WHERE (s.user_uplink_bytes,s.user_downlink_bytes,s.relay_uplink_bytes,s.relay_downlink_bytes)
        IS DISTINCT FROM (SELECT ROW(
            coalesce((SELECT sum(a.uplink_bytes)::bigint FROM usage_samples a WHERE (a.tenant_id,a.node_id,a.window_end)=(s.tenant_id,s.node_id,s.window_end)),0),
            coalesce((SELECT sum(a.downlink_bytes)::bigint FROM usage_samples a WHERE (a.tenant_id,a.node_id,a.window_end)=(s.tenant_id,s.node_id,s.window_end)),0),
            coalesce((SELECT sum(a.uplink_bytes)::bigint FROM usage_chain_samples a WHERE (a.tenant_id,a.node_id,a.window_end)=(s.tenant_id,s.node_id,s.window_end)),0),
            coalesce((SELECT sum(a.downlink_bytes)::bigint FROM usage_chain_samples a WHERE (a.tenant_id,a.node_id,a.window_end)=(s.tenant_id,s.node_id,s.window_end)),0)))) THEN
        RAISE EXCEPTION 'machine projections disagree with retained samples';
    END IF;
END $$;

CREATE TEMP TABLE repair_after (kind text NOT NULL, row_data jsonb NOT NULL);
INSERT INTO repair_after SELECT 'usage_samples',to_jsonb(s) FROM usage_samples s JOIN corrected_users c USING(id);
INSERT INTO repair_after SELECT 'usage_chain_samples',to_jsonb(s) FROM usage_chain_samples s JOIN corrected_relays c USING(id);
INSERT INTO repair_after SELECT 'usage_rollups',to_jsonb(s) FROM usage_rollups s JOIN user_days c
    ON (s.tenant_id,s.user_id,s.app_id,s.period_start)=(c.tenant_id,c.user_id,c.app_id,c.day);
INSERT INTO repair_after SELECT 'usage_user_node_rollups',to_jsonb(s) FROM usage_user_node_rollups s JOIN machine_days c
    ON (s.tenant_id,s.user_id,s.node_id,s.period_start)=(c.tenant_id,c.user_id,c.node_id,c.day);
INSERT INTO repair_after SELECT 'usage_user_ingress_rollups',to_jsonb(s) FROM usage_user_ingress_rollups s JOIN ingress_days c
    ON (s.tenant_id,s.user_id,s.node_id,s.ingress_id,s.period_start)=(c.tenant_id,c.user_id,c.node_id,c.ingress_id,c.day);
INSERT INTO repair_after SELECT 'usage_node_rollups',to_jsonb(s) FROM usage_node_rollups s JOIN node_days c
    ON (s.tenant_id,s.node_id,s.period_start)=(c.tenant_id,c.node_id,c.day);
INSERT INTO repair_after SELECT 'usage_node_windows',to_jsonb(s) FROM usage_node_windows s JOIN node_windows c
    ON (s.tenant_id,s.node_id,s.window_end)=(c.tenant_id,c.node_id,c.window_end);


INSERT INTO brocade_repair.usage_correction_batches(id,plan_sha256,evidence)
SELECT current_setting('brocade.repair_id'),current_setting('brocade.plan_sha256'),jsonb_build_object(
    'reason','confirmed continuous journal -> process fallback -> same journal; preserve measured deltas',
    'plan',(SELECT jsonb_agg(to_jsonb(c) ORDER BY reading_id) FROM correction_plan c),
    'before',(SELECT jsonb_agg(to_jsonb(b) ORDER BY kind,row_data::text) FROM repair_before b),
    'after',(SELECT jsonb_agg(to_jsonb(b) ORDER BY kind,row_data::text) FROM repair_after b),
    'user_samples',(SELECT count(*) FROM corrected_users),'relay_samples',(SELECT count(*) FROM corrected_relays),
    'subtract_up',current_setting('brocade.expected_up')::bigint,
    'subtract_down',current_setting('brocade.expected_down')::bigint,
    'preserved_real_bytes',(SELECT sum(real_up+real_down) FROM correction_plan),
    'raw_readings',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM usage_readings r
        WHERE id IN (SELECT reading_id FROM correction_plan UNION SELECT previous_reading_id FROM correction_plan)));
SELECT jsonb_build_object('repair_id',id,'applied_at',applied_at,'plan_sha256',plan_sha256,
    'user_samples',evidence->'user_samples','relay_samples',evidence->'relay_samples',
    'subtract_up',evidence->'subtract_up','subtract_down',evidence->'subtract_down',
    'preserved_real_bytes',evidence->'preserved_real_bytes')
FROM brocade_repair.usage_correction_batches WHERE id=current_setting('brocade.repair_id');
