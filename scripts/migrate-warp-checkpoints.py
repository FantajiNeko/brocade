#!/usr/bin/env python3
"""One-time, operator-run storage migration; never called by Console startup.

Stop Console writers and back up the database first. Run with PGDATABASE/PGHOST/
PGUSER configured for the intended database. Default is a read-only audit; --apply
atomically converts only unused, unbound default WARP entries and updates client
document hashes. No revision ID, release, serving pointer or encrypted value changes.
"""

import argparse
import copy
import csv
import hashlib
import io
import json
import subprocess


LEGACY_FIELDS = {
    "mtu", "keep_alive", "allowed_ips", "no_kernel_tun", "domain_strategy", "workers"
}
MASQUE_OPTIONS = {"http_version": "h3", "remote_dns": ["1.1.1.1", "1.0.0.1"]}


def canonical(document):
    return json.dumps(document, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(document):
    return hashlib.sha256(canonical(document).encode()).hexdigest()


def convert(document):
    result = copy.deepcopy(document)
    referenced = set()
    for app in result.get("apps", []):
        for step in app.get("steps", []):
            for rule in step.get("rules", []):
                action = rule.get("a", {})
                if action.get("t") == "proxy":
                    referenced.add(action.get("outbound"))
        for front in app.get("fronts", []):
            referenced.update(front.get("external_via", []))
    for front in result.get("fronts", {}).values():
        referenced.update(front.get("external_via", []))
    changed = 0
    for outbound in result.get("external_outbounds", []):
        protocol = outbound.get("protocol", {})
        if protocol.get("t") != "warp":
            continue
        options = protocol.get("v")
        if not isinstance(options, dict):
            raise ValueError("invalid WARP options")
        if not LEGACY_FIELDS.intersection(options):
            if set(options) - set(MASQUE_OPTIONS):
                raise ValueError("unknown WARP options")
            if outbound.get("address") == "engage.cloudflareclient.com" or outbound.get("port") == 2408:
                raise ValueError("MASQUE entry still has a legacy endpoint")
            continue
        if set(options) - LEGACY_FIELDS:
            raise ValueError("mixed or unknown WARP options")
        if outbound.get("bindings", []) != [] or outbound.get("id") in referenced:
            raise ValueError("bound or referenced WARP requires explicit identity migration")
        if outbound.get("address") != "engage.cloudflareclient.com" or outbound.get("port") != 2408:
            raise ValueError("non-default WARP endpoint requires explicit migration")
        if outbound.get("security") != {"t": "none"}:
            raise ValueError("unexpected WARP security")
        protocol["v"] = copy.deepcopy(MASQUE_OPTIONS)
        outbound["address"] = "162.159.198.2"
        outbound["port"] = 443
        changed += 1
    return result, changed


def psql(statement):
    completed = subprocess.run(
        ["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1"],
        input=statement, text=True, capture_output=True, timeout=90,
    )
    if completed.returncode:
        # PostgreSQL diagnostics may include JSON documents containing encrypted secrets.
        raise RuntimeError("database operation failed; inspect checkpoint state before retrying")
    return completed.stdout.strip()


READ_DOCUMENTS = """
BEGIN READ ONLY;
SET LOCAL statement_timeout='15s';
SELECT jsonb_build_object('kind','model','id',revision_id,'document',snapshot,'hash',NULL)
FROM model_snapshots ORDER BY revision_id;
SELECT jsonb_build_object('kind','client','id',id,'document',document,'hash',content_sha256)
FROM subscription_client_snapshots ORDER BY id;
COMMIT;
"""


def prepare(rows):
    converted = []
    report = []
    for row in rows:
        original = row["document"]
        before = digest(original)
        if row["kind"] == "client" and before != row["hash"]:
            raise ValueError("client hash mismatch or unsupported JSON canonicalization")
        document, count = convert(original)
        after = digest(document)
        converted.append((row["kind"], row["id"], canonical(original), canonical(document), row["hash"], after))
        report.append({"kind": row["kind"], "id": row["id"], "converted_warp_entries": count,
                       "before_sha256": before, "after_sha256": after})
    return converted, report


def apply_statement(rows):
    records = io.StringIO()
    csv.writer(records, lineterminator="\n").writerows(rows)
    # Values enter through COPY's data channel, never through SQL interpolation.
    return """
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
LOCK TABLE model_snapshots, subscription_client_snapshots, external_outbounds,
 external_outbound_bindings, deployments, binary_releases, subscription_client_state,
 subscription_serving_state, control_state IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM deployments WHERE active) OR EXISTS (SELECT 1 FROM binary_releases WHERE active)
 THEN RAISE EXCEPTION 'active release'; END IF;
 IF EXISTS (SELECT 1 FROM node_convergence_obligations WHERE status IN
   ('pending','dispatched','converging','failed-recovered','failed-dirty'))
 OR EXISTS (SELECT 1 FROM node_agent_state WHERE xray_upgrade IS NOT NULL AND xray_upgrade<>'null'::jsonb)
 THEN RAISE EXCEPTION 'unsettled node work'; END IF;
 IF EXISTS (SELECT 1 FROM external_outbounds WHERE protocol='warp' AND
   (protocol_options ?| ARRAY['mtu','keep_alive','allowed_ips','no_kernel_tun','domain_strategy','workers']
    OR address='engage.cloudflareclient.com' OR port=2408))
 THEN RAISE EXCEPTION 'live WARP model must already use MASQUE'; END IF;
END $$;
CREATE TEMP TABLE warp_checkpoint_conversion (
 kind text NOT NULL, id bigint NOT NULL, original jsonb NOT NULL, converted jsonb NOT NULL,
 old_hash text, new_hash text NOT NULL, PRIMARY KEY(kind,id)
) ON COMMIT DROP;
COPY warp_checkpoint_conversion FROM STDIN WITH (FORMAT csv);
""" + records.getvalue() + "\\.\n" + """
DO $$ BEGIN
 IF (SELECT count(*) FROM model_snapshots) <> (SELECT count(*) FROM warp_checkpoint_conversion WHERE kind='model')
 OR (SELECT count(*) FROM subscription_client_snapshots) <> (SELECT count(*) FROM warp_checkpoint_conversion WHERE kind='client')
 OR EXISTS (SELECT 1 FROM warp_checkpoint_conversion c
 LEFT JOIN model_snapshots m ON c.kind='model' AND m.revision_id=c.id
 LEFT JOIN subscription_client_snapshots s ON c.kind='client' AND s.id=c.id
 WHERE c.original IS DISTINCT FROM CASE WHEN c.kind='model' THEN m.snapshot ELSE s.document END
 OR (c.kind='client' AND c.old_hash IS DISTINCT FROM s.content_sha256))
 THEN RAISE EXCEPTION 'checkpoint changed since audit'; END IF;
END $$;
UPDATE model_snapshots m SET snapshot=c.converted
FROM warp_checkpoint_conversion c WHERE c.kind='model' AND m.revision_id=c.id AND c.original<>c.converted;
UPDATE subscription_client_snapshots s SET document=c.converted,content_sha256=c.new_hash
FROM warp_checkpoint_conversion c WHERE c.kind='client' AND s.id=c.id AND c.original<>c.converted;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM warp_checkpoint_conversion c
 LEFT JOIN model_snapshots m ON c.kind='model' AND m.revision_id=c.id
 LEFT JOIN subscription_client_snapshots s ON c.kind='client' AND s.id=c.id
 WHERE c.converted IS DISTINCT FROM CASE WHEN c.kind='model' THEN m.snapshot ELSE s.document END
 OR (c.kind='client' AND c.new_hash IS DISTINCT FROM s.content_sha256))
 THEN RAISE EXCEPTION 'checkpoint conversion verification failed'; END IF;
END $$;
COMMIT;
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    rows = [json.loads(line) for line in psql(READ_DOCUMENTS).splitlines()]
    converted, report = prepare(rows)
    if args.apply:
        psql(apply_statement(converted))
    print(json.dumps({"applied": args.apply, "checkpoints": report}, indent=2))


if __name__ == "__main__":
    main()
