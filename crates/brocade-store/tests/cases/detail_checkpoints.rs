use super::*;
use brocade_deployment::other_domain::{OtherDomainCounter, OtherDomainPolicy, OtherDomainReport};
use brocade_deployment::sniffing_failed::{SniffingFailedCounter, SniffingFailedPolicy};

async fn record_checkpoint(db: &TestPg, failed: bool, report: OtherDomainReport) {
    if failed {
        db.store
            .record_sniffing_failed_report(
                "n1",
                report.map_counters(|r| SniffingFailedCounter {
                    counter_id: r.counter_id,
                    bucket: r.bucket,
                    label: r.label,
                    target: r.domain,
                    uplink_bytes: r.uplink_bytes,
                    downlink_bytes: r.downlink_bytes,
                }),
            )
            .await
            .unwrap();
    } else {
        db.store
            .record_other_domain_report("n1", report)
            .await
            .unwrap();
    }
}

async fn checkpoint_replay_case(failed: bool) {
    let Some(db) = TestPg::start_if_enabled().await else {
        return;
    };
    db.store.migrate().await.unwrap();
    insert_minimal_fixture(db.pool()).await;
    let budget = OtherDomainPolicy {
        enabled: true,
        top_n: 1,
        max_domains_per_user: 1,
        node_capacity: 1,
        report_interval_secs: 30,
    };
    if failed {
        db.store
            .update_sniffing_failed_policy(
                &system_admin(),
                SniffingFailedPolicy::from_budget(budget),
            )
            .await
            .unwrap();
    } else {
        db.store
            .update_other_domain_policy(&system_admin(), budget)
            .await
            .unwrap();
    }
    let now: i64 = sqlx::query_scalar("SELECT extract(epoch FROM now())::bigint")
        .fetch_one(db.pool())
        .await
        .unwrap();
    let base = now - 3 * 3600;
    let generation =
        install_usage_generation(db.pool(), "n1", alice_usage_bindings(), base - 60).await;
    let name = |second: bool| -> &str {
        match (failed, second) {
            (false, false) => "a.example",
            (false, true) => "b.example",
            (true, false) => "tcp://192.0.2.1:443",
            (true, true) => "udp://192.0.2.2:53",
        }
    };
    let make = |id, second, up| OtherDomainReport {
        version: 2,
        epoch: "a".repeat(32),
        activation_unix_secs: base - 30,
        read_at_unix_secs: base,
        usage_generation_id: generation,
        limited: false,
        counters: vec![OtherDomainCounter {
            counter_id: id,
            bucket: base / 3600 * 3600,
            label: "alice@platform.acme#ing-a1b2".into(),
            domain: name(second).into(),
            uplink_bytes: up,
            downlink_bytes: 0,
        }],
    };
    let first = make(1, false, 10);
    let second = make(2, true, 20);
    let reentered = make(3, false, 7);
    for report in [&first, &second, &reentered] {
        record_checkpoint(&db, failed, report.clone()).await;
    }
    let (history, heads, state) = if failed {
        (
            "user_sniffing_failed_hourly",
            "sniffing_failed_counter_heads",
            "node_sniffing_failed_state",
        )
    } else {
        (
            "user_other_domain_hourly",
            "other_domain_counter_heads",
            "node_other_domain_state",
        )
    };
    // Literal table names above are the entire allow-list; no external SQL identifiers.
    let total_sql = format!("SELECT sum(uplink_bytes)::bigint FROM {history} WHERE node_id='n1'");
    assert_eq!(
        sqlx::query_scalar::<_, i64>(&total_sql)
            .fetch_one(db.pool())
            .await
            .unwrap(),
        37
    );
    sqlx::query("INSERT INTO admin_operators (id,display_name,role,password_hash) VALUES ('legacy-test','Legacy test','system-admin','test-hash')")
        .execute(db.pool()).await.unwrap();
    sqlx::query("INSERT INTO data_retention_policies (table_name,ttl_hours,updated_by) VALUES ($1,2,'legacy-test') ON CONFLICT (table_name) DO UPDATE SET ttl_hours=2")
        .bind(heads).execute(db.pool()).await.unwrap();
    let schedule = db.store.retention_schedule().await.unwrap();
    assert_eq!(
        schedule.ttl_hours(heads),
        24,
        "old retention overrides must respect replay safety"
    );
    db.store
        .prune_configured_usage_history(&schedule)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(&format!("SELECT count(*) FROM {heads}"))
            .fetch_one(db.pool())
            .await
            .unwrap(),
        3,
        "deduplication must survive the legacy two-hour housekeeping cutoff"
    );
    // Response loss, Agent restart and replay in a different order must add no bytes.
    for report in [&reentered, &first, &second] {
        record_checkpoint(&db, failed, report.clone()).await;
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>(&total_sql)
            .fetch_one(db.pool())
            .await
            .unwrap(),
        37
    );
    let mut newer = first.clone();
    newer.counters[0].uplink_bytes = 15;
    newer.counters[0].downlink_bytes = 5;
    record_checkpoint(&db, failed, newer.clone()).await;
    newer.counters[0].uplink_bytes = 12;
    newer.counters[0].downlink_bytes = 8;
    record_checkpoint(&db, failed, newer).await;
    record_checkpoint(&db, failed, first.clone()).await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>(&total_sql)
            .fetch_one(db.pool())
            .await
            .unwrap(),
        42
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(&format!(
            "SELECT sum(downlink_bytes)::bigint FROM {history}"
        ))
        .fetch_one(db.pool())
        .await
        .unwrap(),
        8
    );
    assert!(
        !sqlx::query_scalar::<_, bool>(&format!("SELECT limited FROM {state} WHERE node_id='n1'"))
            .fetch_one(db.pool())
            .await
            .unwrap(),
        "ordinary cumulative replay must not masquerade as observation loss"
    );
    let mut new_epoch = make(1, false, 4);
    new_epoch.epoch = "b".repeat(32);
    new_epoch.activation_unix_secs = now - 10;
    new_epoch.read_at_unix_secs = now;
    new_epoch.counters[0].bucket = now / 3600 * 3600;
    record_checkpoint(&db, failed, new_epoch).await;
    record_checkpoint(&db, failed, first).await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>(&total_sql)
            .fetch_one(db.pool())
            .await
            .unwrap(),
        46
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(&format!("SELECT epoch FROM {state} WHERE node_id='n1'"))
            .fetch_one(db.pool())
            .await
            .unwrap(),
        "b".repeat(32),
        "delayed old epochs cannot move coverage state backwards"
    );
}

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1 and PostgreSQL"]
async fn detail_checkpoint_domain_replay_is_idempotent_after_eviction_and_retention() {
    checkpoint_replay_case(false).await;
}

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1 and PostgreSQL"]
async fn detail_checkpoint_failed_replay_is_idempotent_after_eviction_and_retention() {
    checkpoint_replay_case(true).await;
}

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1 and PostgreSQL"]
async fn detail_checkpoint_upgrade_transfers_legacy_baseline_once() {
    let Some(db) = TestPg::start_if_enabled().await else {
        return;
    };
    db.store.migrate().await.unwrap();
    insert_minimal_fixture(db.pool()).await;
    let now: i64 = sqlx::query_scalar("SELECT extract(epoch FROM now())::bigint")
        .fetch_one(db.pool())
        .await
        .unwrap();
    let generation =
        install_usage_generation(db.pool(), "n1", alice_usage_bindings(), now - 120).await;
    let mut report = OtherDomainReport {
        version: 1,
        epoch: "a".repeat(32),
        activation_unix_secs: now - 60,
        read_at_unix_secs: now - 30,
        usage_generation_id: generation,
        limited: false,
        counters: vec![OtherDomainCounter {
            counter_id: 0,
            bucket: (now - 30) / 3600 * 3600,
            label: "alice@platform.acme#ing-a1b2".into(),
            domain: "a.example".into(),
            uplink_bytes: 10,
            downlink_bytes: 0,
        }],
    };
    let mut second_legacy = report.counters[0].clone();
    second_legacy.domain = "b.example".into();
    second_legacy.uplink_bytes = 20;
    report.counters.push(second_legacy);
    record_checkpoint(&db, false, report.clone()).await;
    report.version = 2;
    report.counters[0].counter_id = 100;
    report.counters[1].counter_id = 200;
    let mut second_segment = report.counters[1].clone();
    second_segment.counter_id = 201;
    second_segment.uplink_bytes = 4;
    // Coalesced segments may arrive in any row order. Only the earliest admission
    // inherits the legacy baseline; the later small target must retain every byte.
    report.counters.insert(1, second_segment);
    // Equal values still have to persist the transferred v2 baseline.
    record_checkpoint(&db, false, report.clone()).await;
    report.counters.truncate(1);
    let mut reentered = report.clone();
    reentered.counters[0].counter_id = 101;
    reentered.counters[0].uplink_bytes = 3;
    record_checkpoint(&db, false, reentered).await;
    report.counters[0].uplink_bytes = 15;
    record_checkpoint(&db, false, report.clone()).await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT sum(uplink_bytes)::bigint FROM user_other_domain_hourly"
        )
        .fetch_one(db.pool())
        .await
        .unwrap(),
        42,
        "an Agent upgrade must count only new bytes, and a later admission must start at zero"
    );
    report.version = 1;
    report.counters[0].counter_id = 0;
    assert!(
        db.store
            .record_other_domain_report("n1", report)
            .await
            .is_err(),
        "a v1 downgrade within a v2 epoch cannot safely identify readmissions"
    );
}
