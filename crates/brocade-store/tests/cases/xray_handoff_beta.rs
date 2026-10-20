use super::*;
use brocade_deployment::protocol::XrayConfigUpdatePolicy;
use brocade_store::UpdateDeploymentSettings;

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1 and PostgreSQL"]
async fn beta_defaults_off_is_admin_only_and_partial_saves_preserve_other_settings() {
    let Some(db) = TestPg::start_if_enabled().await else {
        return;
    };
    db.store.migrate().await.unwrap();
    insert_minimal_fixture(db.pool()).await;
    let initial = db.store.deployment_settings().await.unwrap();
    assert!(!initial.xray_handoff_beta);
    assert!(db.store.site_usage_policy().await.unwrap().enabled);
    assert!(db.store.other_domain_policy().await.unwrap().enabled);
    assert!(db.store.sniffing_failed_policy().await.unwrap().enabled);
    assert_eq!(
        db.store
            .settings()
            .await
            .unwrap()
            .reality_site
            .fingerprint
            .as_deref(),
        Some("safari")
    );
    sqlx::query(
        "UPDATE control_state SET site_usage_enabled=FALSE,
        other_domain_policy=jsonb_set(other_domain_policy,'{enabled}','false'),
        sniffing_failed_policy=jsonb_set(sniffing_failed_policy,'{enabled}','false'),
        reality_fingerprint='chrome'",
    )
    .execute(db.pool())
    .await
    .unwrap();
    for sql in [
        include_str!("../../../../scripts/compat-traffic-observation-defaults.sql"),
        include_str!("../../../../scripts/compat-tls-fingerprint-default.sql"),
    ] {
        sqlx::raw_sql(sql).execute(db.pool()).await.unwrap();
    }
    assert!(!db.store.site_usage_policy().await.unwrap().enabled);
    assert!(!db.store.other_domain_policy().await.unwrap().enabled);
    assert!(!db.store.sniffing_failed_policy().await.unwrap().enabled);
    assert_eq!(
        db.store
            .settings()
            .await
            .unwrap()
            .reality_site
            .fingerprint
            .as_deref(),
        Some("chrome")
    );
    let before: i64 = sqlx::query_scalar("SELECT current_revision FROM control_state")
        .fetch_one(db.pool())
        .await
        .unwrap();
    let enable = UpdateDeploymentSettings {
        xray_handoff_beta: Some(true),
        ..Default::default()
    };
    for actor in [publisher("platform.acme"), tenant_admin("platform.acme")] {
        assert!(matches!(
            db.store.update_deployment_settings(&actor, enable).await,
            Err(StoreError::Forbidden(_))
        ));
    }
    let settings = db
        .store
        .update_deployment_settings(&system_admin(), enable)
        .await
        .unwrap();
    assert!(settings.xray_handoff_beta && settings.unattended);
    let settings = db
        .store
        .update_deployment_settings(
            &system_admin(),
            UpdateDeploymentSettings {
                unattended: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(settings.xray_handoff_beta);
    assert!(!settings.unattended);
    let after: i64 = sqlx::query_scalar("SELECT current_revision FROM control_state")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(before, after);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM deployments")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
    sqlx::raw_sql(include_str!(
        "../../../../scripts/compat-xray-handoff-beta.sql"
    ))
    .execute(db.pool())
    .await
    .unwrap();
    assert!(
        db.store
            .deployment_settings()
            .await
            .unwrap()
            .xray_handoff_beta
    );
}

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1 and PostgreSQL"]
async fn config_policy_is_frozen_at_creation_including_isolation_and_legacy_orders() {
    let Some(db) = TestPg::start_if_enabled().await else {
        return;
    };
    db.store.migrate().await.unwrap();
    insert_minimal_fixture(db.pool()).await;
    insert_second_node(db.pool()).await;
    let admin = system_admin();
    db.store
        .isolate_node(
            &admin,
            "n2",
            IsolateNodeRequest {
                acknowledge_uncertain: false,
            },
        )
        .await
        .unwrap();
    let first = db
        .store
        .create_deployment(&admin, create_deployment_request(1, "beta-off-frozen"))
        .await
        .unwrap();
    assert!(db
        .store
        .claim_desired_for_node_with_protocol("n1", 36)
        .await
        .unwrap()
        .is_none());
    let status: String = sqlx::query_scalar(
        "SELECT status FROM deployment_targets WHERE deployment_id=$1 AND node_id='n1'",
    )
    .bind(first.deployment_id)
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(
        status, "pending",
        "an incompatible poll must not claim the target"
    );
    db.store
        .update_deployment_settings(
            &admin,
            UpdateDeploymentSettings {
                xray_handoff_beta: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let desired = db.store.load_desired_for_node("n1").await.unwrap().unwrap();
    assert_eq!(
        desired.xray_config_update_policy,
        Some(XrayConfigUpdatePolicy::Restart)
    );
    let obligation: String = sqlx::query_scalar(
        "SELECT desired_structure->>'xray_config_update_policy'
        FROM node_convergence_obligations WHERE source_deployment_id=$1 AND node_id='n2'",
    )
    .bind(first.deployment_id)
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(obligation, "restart");
    let repeat = db
        .store
        .create_deployment(&admin, create_deployment_request(1, "beta-off-frozen"))
        .await
        .unwrap();
    assert!(repeat.reused);
    assert_eq!(
        db.store
            .load_desired_for_node("n1")
            .await
            .unwrap()
            .unwrap()
            .xray_config_update_policy,
        desired.xray_config_update_policy
    );
    db.store
        .cancel_deployment(&admin, first.deployment_id)
        .await
        .unwrap();
    let second = db
        .store
        .create_deployment(&admin, create_deployment_request(1, "beta-on-frozen"))
        .await
        .unwrap();
    db.store
        .update_deployment_settings(
            &admin,
            UpdateDeploymentSettings {
                xray_handoff_beta: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let desired = db
        .store
        .claim_desired_for_node("n1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        desired.xray_config_update_policy,
        Some(XrayConfigUpdatePolicy::Handoff)
    );
    let detail = db
        .store
        .deployment_detail(&admin, second.deployment_id, false)
        .await
        .unwrap();
    assert!(detail
        .targets
        .iter()
        .all(|t| t.desired_structure["xray_config_update_policy"] == "handoff"));
    sqlx::query("UPDATE deployment_target_state SET desired_structure=desired_structure-'xray_config_update_policy'
        WHERE deployment_id=$1 AND node_id='n1'")
        .bind(second.deployment_id).execute(db.pool()).await.unwrap();
    assert_eq!(
        db.store
            .load_desired_for_node("n1")
            .await
            .unwrap()
            .unwrap()
            .xray_config_update_policy,
        None
    );
}
