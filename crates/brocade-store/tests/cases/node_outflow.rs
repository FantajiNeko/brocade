use super::*;

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1 and PostgreSQL"]
async fn node_site_usage_includes_forwarding_ledger_and_retained_series() {
    let Some(db) = TestPg::start_if_enabled().await else {
        return;
    };
    db.store.migrate().await.unwrap();
    insert_minimal_fixture(db.pool()).await;
    sqlx::query("INSERT INTO nodes (id,tenant_id,name,public_ipv4,overlay_addr,wg_private_key,wg_public_key,wg_listen_port,api_port,overlay,egress_allowed,dns_kind,dns_servers)
        VALUES ('n2','platform.acme','Forwarding only','n2.example.net','10.66.0.2','private-2','public-2',51820,10085,true,true,'servers','[\"1.1.1.1\"]')")
        .execute(db.pool()).await.unwrap();
    sqlx::query("INSERT INTO tenants (id,name) VALUES ('platform.acme.child','Child'),('platform.other','Other')")
        .execute(db.pool()).await.unwrap();
    let (day, now): (i64, i64) = sqlx::query_as("SELECT extract(epoch FROM (date_trunc('day',now() AT TIME ZONE 'Asia/Hong_Kong') AT TIME ZONE 'Asia/Hong_Kong'))::bigint, extract(epoch FROM now())::bigint")
        .fetch_one(db.pool()).await.unwrap();
    for (index, (tenant, user, node, up, down)) in [
        ("platform.acme", "alice", "n1", 30_i64, 70_i64),
        ("platform.acme", "bob", "n1", 20, 40),
        ("platform.acme", "carol", "n1", 10, 20),
        ("platform.acme", "dave", "n1", 5, 10),
        ("platform.acme.child", "alice", "n1", 2, 3),
        ("platform.other", "alice", "n1", 1000, 2000),
        ("platform.acme", "alice", "n2", 5000, 5000),
        ("platform.acme", "alice", "n1", 3, 7),
    ]
    .into_iter()
    .enumerate()
    {
        sqlx::query("INSERT INTO users (tenant_id,id,uuid) VALUES ($1,$2,gen_random_uuid()) ON CONFLICT (tenant_id,id) DO NOTHING")
            .bind(tenant).bind(user).execute(db.pool()).await.unwrap();
        let rule: i64 = sqlx::query_scalar("INSERT INTO forwarding_rules (tenant_id,user_id,node_id,name,protocol,listen_port,target_host,target_port) VALUES ($1,$2,$3,'Forwarding','tcp',$4,'192.0.2.1',443) RETURNING id")
            .bind(tenant).bind(user).bind(node).bind(21000 + index as i32)
            .fetch_one(db.pool()).await.unwrap();
        sqlx::query("INSERT INTO forwarding_usage_rollups (period_start,node_id,tenant_id,user_id,rule_id,uplink_bytes,downlink_bytes,has_gap) VALUES (to_timestamp($1),$2,$3,$4,$5,$6,$7,false)")
            .bind(day as f64).bind(node).bind(tenant).bind(user).bind(rule).bind(up).bind(down)
            .execute(db.pool()).await.unwrap();
        // The read may be much later than its window; attribution must follow the window start.
        // The child also covers legacy first readings without a measured start.
        sqlx::query("INSERT INTO forwarding_usage_samples (node_id,rule_id,tenant_id,user_id,read_at,window_start,uplink_bytes,downlink_bytes) VALUES ($1,$2,$3,$4,to_timestamp($5),to_timestamp($6),$7,$8)")
            // Keep the legacy read strictly inside the half-open query range. Using the
            // database clock rounded to a whole second here made the row sit exactly on the
            // exclusive upper bound when the test and query ran within the same second.
            .bind(node).bind(rule).bind(tenant).bind(user).bind((now - 1) as f64)
            .bind((index != 4).then_some(day as f64)).bind(up).bind(down)
            .execute(db.pool()).await.unwrap();
        if index == 0 {
            // Old windows reported today and future windows must stay outside every current view.
            for at in [day - 40 * 86_400, day + 40 * 86_400] {
                sqlx::query("INSERT INTO forwarding_usage_rollups (period_start,node_id,tenant_id,user_id,rule_id,uplink_bytes,downlink_bytes,has_gap) VALUES (to_timestamp($1),$2,$3,$4,$5,10000,10000,false)")
                    .bind(at as f64).bind(node).bind(tenant).bind(user).bind(rule)
                    .execute(db.pool()).await.unwrap();
                sqlx::query("INSERT INTO forwarding_usage_samples (node_id,rule_id,tenant_id,user_id,read_at,window_start,uplink_bytes,downlink_bytes) VALUES ($1,$2,$3,$4,to_timestamp($5),to_timestamp($6),10000,10000)")
                    .bind(node).bind(rule).bind(tenant).bind(user).bind(now.max(at) as f64).bind(at as f64)
                    .execute(db.pool()).await.unwrap();
            }
        }
    }
    sqlx::query("INSERT INTO user_site_usage_hourly (bucket,node_id,tenant_id,user_id,site_id,uplink_bytes,downlink_bytes) VALUES ($1,'n1','platform.acme','alice','github',10,90)")
        .bind(day).execute(db.pool()).await.unwrap();
    // Forwarding is independent of the site collection switch and reporter support.
    sqlx::query("UPDATE control_state SET site_usage_enabled=false WHERE id=true")
        .execute(db.pool())
        .await
        .unwrap();
    for period in [
        SiteUsagePeriod::Day,
        SiteUsagePeriod::Week,
        SiteUsagePeriod::Month,
    ] {
        let view = db
            .store
            .node_site_usage(&tenant_admin("platform.acme"), "n1", period)
            .await
            .unwrap();
        let forwarding = view
            .usage
            .rows
            .iter()
            .find(|row| row.site_id == "forwarding")
            .unwrap();
        assert_eq!(forwarding.name, "端口转发");
        assert_eq!(
            (forwarding.uplink_bytes, forwarding.downlink_bytes),
            (70, 150)
        );
        assert!(!view.usage.collection_enabled);
        assert_eq!(view.usage.reporting_nodes, 0);
        assert_eq!(
            view.usage
                .rows
                .iter()
                .map(|row| row.uplink_bytes + row.downlink_bytes)
                .sum::<u64>(),
            320
        );
        let series = view
            .usage
            .series
            .iter()
            .find(|series| series.site_id == "forwarding")
            .unwrap();
        assert_eq!(
            series
                .points
                .iter()
                .map(|point| point.1 + point.2)
                .sum::<u64>(),
            220
        );
        assert_eq!(series.points[0].0, day);
        let users = view
            .top_users
            .iter()
            .find(|row| row.site_id == "forwarding")
            .unwrap();
        assert_eq!(
            users
                .users
                .iter()
                .map(|user| user.user_id.as_str())
                .collect::<Vec<_>>(),
            ["alice", "bob", "carol", "dave"]
        );
        assert_eq!(
            (users.users[0].uplink_bytes, users.users[0].downlink_bytes),
            (33, 77)
        );
        assert_eq!(
            (
                users.other_users,
                users.other_uplink_bytes,
                users.other_downlink_bytes
            ),
            (1, 2, 3)
        );
    }
    let all = db
        .store
        .node_site_usage(&system_admin(), "n1", SiteUsagePeriod::Day)
        .await
        .unwrap();
    assert_eq!(
        all.usage
            .rows
            .iter()
            .find(|row| row.site_id == "forwarding")
            .map(|row| row.uplink_bytes + row.downlink_bytes),
        Some(3220)
    );
    let only_forwarding = db
        .store
        .node_site_usage(&tenant_admin("platform.acme"), "n2", SiteUsagePeriod::Day)
        .await
        .unwrap();
    assert_eq!(only_forwarding.usage.expected_nodes, 0);
    assert_eq!(only_forwarding.usage.rows.len(), 1);
    assert_eq!(only_forwarding.usage.rows[0].site_id, "forwarding");
    assert_eq!(only_forwarding.usage.rows[0].uplink_bytes, 5000);
    for period in [
        SiteUsagePeriod::Day,
        SiteUsagePeriod::Week,
        SiteUsagePeriod::Month,
    ] {
        let user_sites = db
            .store
            .user_site_usage(
                &tenant_admin("platform.acme"),
                "platform.acme",
                "alice",
                period,
            )
            .await
            .unwrap();
        let forwarding = &user_sites.rows[0];
        assert_eq!(forwarding.site_id, "forwarding");
        // The same user's machines/rules merge, but other users and child-tenant names do not.
        assert_eq!(
            (forwarding.uplink_bytes, forwarding.downlink_bytes),
            (5033, 5077)
        );
        assert_eq!(
            user_sites
                .rows
                .iter()
                .map(|row| row.uplink_bytes + row.downlink_bytes)
                .sum::<u64>(),
            10210
        );
        assert_eq!(user_sites.series[0].points, [(day, 5033, 5077)]);
        assert!(!user_sites.collection_enabled);
    }
    // A forwarding-only user keeps its history after the rule is removed from current targets.
    sqlx::query("UPDATE forwarding_rules SET enabled=false,deleted_at=now() WHERE tenant_id='platform.acme' AND user_id='bob'")
        .execute(db.pool()).await.unwrap();
    let forwarding_only = db
        .store
        .user_site_usage(
            &tenant_admin("platform.acme"),
            "platform.acme",
            "bob",
            SiteUsagePeriod::Day,
        )
        .await
        .unwrap();
    assert_eq!(forwarding_only.expected_nodes, 0);
    assert_eq!(forwarding_only.rows.len(), 1);
    assert_eq!(forwarding_only.rows[0].site_id, "forwarding");
    assert_eq!(
        (
            forwarding_only.rows[0].uplink_bytes,
            forwarding_only.rows[0].downlink_bytes
        ),
        (20, 40)
    );
    assert!(matches!(
        db.store
            .user_site_usage(
                &tenant_admin("platform.other"),
                "platform.acme",
                "alice",
                SiteUsagePeriod::Day,
            )
            .await,
        Err(StoreError::Forbidden(_))
    ));
    for actor in [
        AdminContext::new("public", AdminRole::Readonly, None),
        ordinary_user("platform.acme"),
    ] {
        assert!(matches!(
            db.store
                .node_site_usage(&actor, "n1", SiteUsagePeriod::Day)
                .await,
            Err(StoreError::Forbidden(_))
        ));
        assert!(matches!(
            db.store
                .user_site_usage(&actor, "platform.acme", "alice", SiteUsagePeriod::Day,)
                .await,
            Err(StoreError::Forbidden(_))
        ));
    }
    // Hourly detail retention must never reduce the ledger total or invent a distribution.
    sqlx::query("DELETE FROM forwarding_usage_samples")
        .execute(db.pool())
        .await
        .unwrap();
    for period in [
        SiteUsagePeriod::Day,
        SiteUsagePeriod::Week,
        SiteUsagePeriod::Month,
    ] {
        let view = db
            .store
            .node_site_usage(&tenant_admin("platform.acme"), "n1", period)
            .await
            .unwrap();
        let row = view
            .usage
            .rows
            .iter()
            .find(|row| row.site_id == "forwarding")
            .unwrap();
        assert_eq!(row.uplink_bytes + row.downlink_bytes, 220);
        let series = view
            .usage
            .series
            .iter()
            .find(|series| series.site_id == "forwarding")
            .unwrap();
        if period == SiteUsagePeriod::Month {
            assert_eq!(series.points, [(day, 70, 150)]);
        } else {
            assert!(series.points.is_empty());
        }
        let user_sites = db
            .store
            .user_site_usage(&system_admin(), "platform.acme", "alice", period)
            .await
            .unwrap();
        assert_eq!(
            (
                user_sites.rows[0].uplink_bytes,
                user_sites.rows[0].downlink_bytes
            ),
            (5033, 5077)
        );
        if period == SiteUsagePeriod::Month {
            assert_eq!(user_sites.series[0].points, [(day, 5033, 5077)]);
        } else {
            assert!(user_sites.series[0].points.is_empty());
        }
    }
}
