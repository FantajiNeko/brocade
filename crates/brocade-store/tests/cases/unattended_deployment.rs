use super::*;
use brocade_store::UpdateDeploymentSettings;

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1 and PostgreSQL"]
async fn unattended_settings_default_on_persist_without_revision_and_reject_non_admin() {
    let Some(db) = TestPg::start_if_enabled().await else {
        return;
    };
    db.store.migrate().await.unwrap();
    insert_minimal_fixture(db.pool()).await;
    assert!(db.store.deployment_settings().await.unwrap().unattended);
    let before: i64 =
        sqlx::query_scalar("SELECT current_revision FROM control_state WHERE id = TRUE")
            .fetch_one(db.pool())
            .await
            .unwrap();
    for actor in [publisher("platform.acme"), tenant_admin("platform.acme")] {
        assert!(matches!(
            db.store
                .update_deployment_settings(
                    &actor,
                    UpdateDeploymentSettings {
                        unattended: Some(false),
                        ..Default::default()
                    }
                )
                .await,
            Err(StoreError::Forbidden(_))
        ));
    }
    assert!(db.store.deployment_settings().await.unwrap().unattended);
    db.store
        .update_deployment_settings(
            &system_admin(),
            UpdateDeploymentSettings {
                unattended: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(!db.store.deployment_settings().await.unwrap().unattended);
    let after: i64 =
        sqlx::query_scalar("SELECT current_revision FROM control_state WHERE id = TRUE")
            .fetch_one(db.pool())
            .await
            .unwrap();
    assert_eq!(before, after);
    let deployments: i64 = sqlx::query_scalar("SELECT count(*) FROM deployments")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(deployments, 0);
}

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1 and PostgreSQL"]
async fn unattended_setting_releases_waiting_wave_immediately_for_read_claim_and_lists() {
    let Some(db) = TestPg::start_if_enabled().await else {
        return;
    };
    db.store.migrate().await.unwrap();
    insert_minimal_fixture(db.pool()).await;
    insert_second_node(db.pool()).await;
    let admin = system_admin();
    db.store
        .update_deployment_settings(
            &admin,
            UpdateDeploymentSettings {
                unattended: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let created = db
        .store
        .create_deployment(&admin, create_deployment_request(1, "unattended-toggle"))
        .await
        .unwrap();
    assert!(db
        .store
        .load_desired_for_node("n2")
        .await
        .unwrap()
        .is_none());
    let first = db
        .store
        .claim_desired_for_node("n1")
        .await
        .unwrap()
        .unwrap();
    db.store
        .report_target_result(applied_report(&first))
        .await
        .unwrap();
    for actor in [&admin, &publisher("platform.acme")] {
        for active_only in [true, false] {
            let list = db
                .store
                .list_deployments(actor, 10, None, active_only)
                .await
                .unwrap();
            assert!(list
                .deployments
                .iter()
                .any(|d| d.id == created.deployment_id && d.awaiting_confirmation));
        }
    }
    assert!(db
        .store
        .load_desired_for_node("n2")
        .await
        .unwrap()
        .is_none());
    assert!(db
        .store
        .claim_desired_for_node("n2")
        .await
        .unwrap()
        .is_none());
    db.store
        .update_deployment_settings(
            &admin,
            UpdateDeploymentSettings {
                unattended: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    for actor in [&admin, &publisher("platform.acme")] {
        for active_only in [true, false] {
            let list = db
                .store
                .list_deployments(actor, 10, None, active_only)
                .await
                .unwrap();
            assert!(list
                .deployments
                .iter()
                .any(|d| d.id == created.deployment_id && !d.awaiting_confirmation));
        }
    }
    let next = db.store.load_desired_for_node("n2").await.unwrap().unwrap();
    assert_eq!(next.wave, 2);
    let next = db
        .store
        .claim_desired_for_node("n2")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(next.wave, 2);
    let confirmations: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM deployment_wave_confirmations WHERE deployment_id = $1",
    )
    .bind(created.deployment_id)
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(confirmations, 0);
    db.store
        .report_target_result(failed_recovered_report(&next))
        .await
        .unwrap();
    db.store
        .update_deployment_settings(
            &admin,
            UpdateDeploymentSettings {
                unattended: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    db.store
        .update_deployment_settings(
            &admin,
            UpdateDeploymentSettings {
                unattended: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        db.store
            .deployment_detail(&admin, created.deployment_id, false)
            .await
            .unwrap()
            .status,
        "halted"
    );
    assert!(db
        .store
        .load_desired_for_node("n2")
        .await
        .unwrap()
        .is_none());
    assert!(db
        .store
        .claim_desired_for_node("n2")
        .await
        .unwrap()
        .is_none());
}
