use super::*;
use brocade_deployment::source_traffic::TrafficTimeRange;

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1 and PostgreSQL"]
async fn machine_history_follows_calendar_and_custom_ranges_with_scoped_forwarding() {
    let Some(db) = TestPg::start_if_enabled().await else {
        return;
    };
    db.store.migrate().await.unwrap();
    insert_minimal_fixture(db.pool()).await;
    let end: i64 = sqlx::query_scalar("SELECT floor(extract(epoch FROM now())/30)::bigint*30")
        .fetch_one(db.pool())
        .await
        .unwrap();
    sqlx::query("INSERT INTO tenants (id,name) VALUES ('platform.other','Other')")
        .execute(db.pool())
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (tenant_id,id,uuid) VALUES ('platform.other','bob','7f0bdc55-55c4-4b9e-9b8e-4f62e6c1a9d0')").execute(db.pool()).await.unwrap();
    // Both windows predate the old fixed hour. Identity aggregation must still enforce tenant scope.
    for (tenant, user, ingress, bytes) in [
        ("platform.acme", "alice", "ing-a1b2", 300_i64),
        ("platform.acme", "alice", "ing-c3d4", 600),
        ("platform.other", "bob", "ing-e5f6", 9000),
    ] {
        sqlx::query("INSERT INTO usage_samples (window_start,window_end,node_id,tenant_id,user_id,ingress_id,app_id,grant_label,uplink_bytes,downlink_bytes,has_gap) VALUES (to_timestamp($1),to_timestamp($2),'n1',$3,$4,$5,'app-main',$4||'@'||$3||'#'||$5,$6,$6,false)")
            .bind((end-7230) as f64).bind((end-7200) as f64).bind(tenant).bind(user).bind(ingress).bind(bytes).execute(db.pool()).await.unwrap();
    }
    let rule: i64 = sqlx::query_scalar("INSERT INTO forwarding_rules (tenant_id,user_id,node_id,name,protocol,listen_port,target_host,target_port) VALUES ('platform.acme','alice','n1','Forwarding','tcp',24001,'192.0.2.2',443) RETURNING id").fetch_one(db.pool()).await.unwrap();
    sqlx::query("INSERT INTO usage_node_windows (node_id,tenant_id,window_end,user_uplink_bytes,user_downlink_bytes,relay_uplink_bytes,relay_downlink_bytes) VALUES ('n1','platform.acme',to_timestamp($1),900,900,999999,999999),('n1','platform.other',to_timestamp($1),9000,9000,0,0)")
        .bind((end-7200) as f64).execute(db.pool()).await.unwrap();
    sqlx::query("INSERT INTO forwarding_usage_windows (node_id,tenant_id,window_start,window_end,uplink_bytes,downlink_bytes,has_gap) VALUES ('n1','platform.acme',to_timestamp($1),to_timestamp($2),300,600,false),('n1','platform.acme',to_timestamp($2),to_timestamp($3),100,200,true)")
        .bind((end-7230) as f64).bind((end-7200) as f64).bind((end-7170) as f64).execute(db.pool()).await.unwrap();
    sqlx::query("INSERT INTO forwarding_usage_samples (node_id,rule_id,tenant_id,user_id,read_at,window_start,uplink_bytes,downlink_bytes,has_gap) VALUES ('n1',$1,'platform.acme','alice',to_timestamp($2),to_timestamp($3),300,600,false),('n1',$1,'platform.acme','alice',to_timestamp($4),NULL,100,200,true)")
        .bind(rule).bind((end-7200) as f64).bind((end-7230) as f64).bind((end-7170) as f64).execute(db.pool()).await.unwrap();
    let range = TrafficTimeRange {
        start_unix_secs: end - 10800,
        end_unix_secs: end,
    };
    let scoped = db
        .store
        .node_traffic_history(
            &tenant_admin("platform.acme"),
            "n1",
            SiteUsagePeriod::Day,
            Some(range),
        )
        .await
        .unwrap();
    assert_eq!(scoped.range_start_unix_secs, range.start_unix_secs);
    assert_eq!(scoped.range_end_unix_secs, range.end_unix_secs);
    assert_eq!(scoped.bucket_secs, 300);
    assert_eq!(scoped.points.len(), 36);
    assert_eq!(scoped.recorded_bytes, 2700.0);
    assert!(scoped.has_gap && scoped.has_unplaced);
    let observed: Vec<_> = scoped
        .points
        .iter()
        .filter(|point| point.1.is_some())
        .collect();
    assert_eq!(observed.len(), 1);
    assert_eq!(observed[0].1, Some(40.0));
    assert_eq!(observed[0].2, Some(50.0));
    let all = db
        .store
        .node_traffic_history(&system_admin(), "n1", SiteUsagePeriod::Day, Some(range))
        .await
        .unwrap();
    assert_eq!(all.recorded_bytes, 20700.0);
    let generation =
        install_usage_generation(db.pool(), "n1", alice_usage_bindings(), end - 10800).await;
    let receipt = json!({"node_id":"n1","agent_instance_id":"history-test","sequence":1,"usage_generation_id":generation,
        "duplicate":false,"accepted_readings":1,"inserted_samples":1,"skipped_counters":0,"rejected_counters":0,"gap_samples":0,
        "window_start_unix_secs":end-7230});
    sqlx::query("INSERT INTO usage_report_receipts (node_id,agent_instance_id,sequence,payload_sha256,generation_id,read_at,result) VALUES ('n1','history-test',1,repeat('a',64),$1,to_timestamp($2),$3)")
        .bind(generation).bind((end-7200) as f64).bind(receipt.clone()).execute(db.pool()).await.unwrap();
    // Detail and chart windows have independent retention policies. Pruning user/rule details
    // must not erase machine totals or turn nonzero ledger windows into idle observations.
    sqlx::query("DELETE FROM usage_samples")
        .execute(db.pool())
        .await
        .unwrap();
    sqlx::query("DELETE FROM forwarding_usage_samples")
        .execute(db.pool())
        .await
        .unwrap();
    let retained = db
        .store
        .node_traffic_history(
            &tenant_admin("platform.acme"),
            "n1",
            SiteUsagePeriod::Day,
            Some(range),
        )
        .await
        .unwrap();
    assert_eq!(retained.recorded_bytes, scoped.recorded_bytes);
    assert_eq!(retained.points, scoped.points);
    sqlx::query("DELETE FROM usage_report_receipts")
        .execute(db.pool())
        .await
        .unwrap();
    let unknown = db
        .store
        .node_traffic_history(
            &tenant_admin("platform.acme"),
            "n1",
            SiteUsagePeriod::Day,
            Some(range),
        )
        .await
        .unwrap();
    assert!(unknown.has_unplaced);
    assert!(
        unknown
            .points
            .iter()
            .all(|point| point.1.is_none() && point.2.is_none()),
        "missing duration cannot become zero or a fabricated 30-second rate"
    );
    sqlx::query("INSERT INTO usage_report_receipts (node_id,agent_instance_id,sequence,payload_sha256,generation_id,read_at,result) VALUES ('n1','history-test',1,repeat('a',64),$1,to_timestamp($2),$3)")
        .bind(generation).bind((end-7200) as f64).bind(receipt).execute(db.pool()).await.unwrap();
    sqlx::query("DELETE FROM usage_node_windows")
        .execute(db.pool())
        .await
        .unwrap();
    sqlx::query("DELETE FROM forwarding_usage_windows")
        .execute(db.pool())
        .await
        .unwrap();
    let expired = db
        .store
        .node_traffic_history(
            &tenant_admin("platform.acme"),
            "n1",
            SiteUsagePeriod::Day,
            Some(range),
        )
        .await
        .unwrap();
    assert!(
        expired
            .points
            .iter()
            .all(|point| point.1.is_none() && point.2.is_none()),
        "receipts alone cannot turn expired chart windows into idle traffic"
    );
    let other = db
        .store
        .node_traffic_history(
            &system_admin(),
            "missing",
            SiteUsagePeriod::Day,
            Some(range),
        )
        .await
        .unwrap();
    assert!(other
        .points
        .iter()
        .all(|point| point.1.is_none() && point.2.is_none()));
    for (period, step) in [
        (SiteUsagePeriod::Day, 300),
        (SiteUsagePeriod::Week, 900),
        (SiteUsagePeriod::Month, 3600),
    ] {
        let output = db
            .store
            .node_traffic_history(&system_admin(), "n1", period, None)
            .await
            .unwrap();
        let expected: i64 = sqlx::query_scalar("SELECT extract(epoch FROM date_trunc($1,now() AT TIME ZONE 'Asia/Hong_Kong') AT TIME ZONE 'Asia/Hong_Kong')::bigint")
            .bind(period.calendar_unit()).fetch_one(db.pool()).await.unwrap();
        assert_eq!(output.range_start_unix_secs, expected);
        assert_eq!(output.bucket_secs, step);
        assert!(output.points.len() <= 744);
    }
    assert!(matches!(
        db.store
            .node_traffic_history(
                &ordinary_user("platform.acme"),
                "n1",
                SiteUsagePeriod::Day,
                Some(range)
            )
            .await,
        Err(StoreError::Forbidden(_))
    ));
    let invalid = TrafficTimeRange {
        start_unix_secs: end - 32 * 86400,
        end_unix_secs: end,
    };
    assert!(db
        .store
        .node_traffic_history(&system_admin(), "n1", SiteUsagePeriod::Day, Some(invalid))
        .await
        .is_err());
}
