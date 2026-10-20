use super::*;
use brocade_store::{NodeInitializationState, ProvisionNodeResult};

async fn start() -> Option<TestPg> {
    let db = TestPg::start_if_enabled().await?;
    db.store.migrate().await.unwrap();
    sqlx::query("INSERT INTO tenants(id,name) VALUES('platform.acme','Lab')")
        .execute(db.pool())
        .await
        .unwrap();
    db.store.ensure_default_app_group().await.unwrap();
    Some(db)
}

async fn enroll(db: &TestPg, id: &str, overlay: bool) -> ProvisionNodeResult {
    let mut request = provision_node_request(id);
    request.overlay = overlay;
    let result = db
        .store
        .provision_node(&system_admin(), request)
        .await
        .unwrap();
    db.store
        .redeem_node_enrollment(&result.enrollment.token)
        .await
        .unwrap();
    result
}

async fn online(db: &TestPg, id: &str) {
    db.store
        .record_node_poll_with_protocol(
            id,
            Some(AGENT_BUILD),
            Some(
                brocade_deployment::protocol::CONFIG_XRAY_FORCE_RETIREMENT_PROTOCOL_VERSION as i32,
            ),
        )
        .await
        .unwrap();
}

async fn status(db: &TestPg, id: &str) -> brocade_store::NodeInitialization {
    db.store
        .list_node_agent_states(&system_admin())
        .await
        .unwrap()
        .nodes
        .into_iter()
        .find(|node| node.node_id == id)
        .unwrap()
        .initialization
        .unwrap()
}

async fn complete(db: &TestPg, id: &str) -> i64 {
    online(db, id).await;
    db.store.process_node_initialization().await.unwrap();
    let desired = db
        .store
        .claim_desired_for_node(id)
        .await
        .unwrap()
        .expect("bootstrap must dispatch");
    db.store
        .report_target_result(applied_report(&desired))
        .await
        .unwrap();
    db.store.process_node_initialization().await.unwrap();
    desired.deployment_id
}

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1 and PostgreSQL"]
async fn node_initialization_only_releases_the_new_machine_and_never_activates_business() {
    let Some(db) = start().await else { return };
    enroll(&db, "old", false).await;
    complete(&db, "old").await;
    let old_sha: String =
        sqlx::query_scalar("SELECT xray_sha256 FROM node_applied_state WHERE node_id='old'")
            .fetch_one(db.pool())
            .await
            .unwrap();
    enroll(&db, "new", false).await;
    assert_eq!(
        status(&db, "new").await.state,
        NodeInitializationState::WaitingAgent
    );
    db.store.process_node_initialization().await.unwrap();
    assert_eq!(status(&db, "new").await.deployment_id, None);
    let deployment = complete(&db, "new").await;
    let detail = db
        .store
        .deployment_detail(&system_admin(), deployment, false)
        .await
        .unwrap();
    assert_eq!(detail.status, "succeeded");
    assert_eq!(detail.targets.len(), 1);
    assert_eq!(detail.targets[0].node_id, "new");
    assert_eq!(detail.actor.as_deref(), Some("system:node-initialization"));
    assert_ne!(detail.activation_status, "activated");
    assert_eq!(
        status(&db, "new").await.state,
        NodeInitializationState::Succeeded
    );
    let actual: String =
        sqlx::query_scalar("SELECT xray_sha256 FROM node_applied_state WHERE node_id='old'")
            .fetch_one(db.pool())
            .await
            .unwrap();
    assert_eq!(actual, old_sha);
    assert!(db
        .store
        .claim_desired_for_node("old")
        .await
        .unwrap()
        .is_none());
    let serving: i64 = sqlx::query_scalar("SELECT count(*) FROM subscription_serving_state")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(serving, 0, "bootstrap is not a business serving checkpoint");
    let verify = db
        .store
        .plan_deployment(
            &system_admin(),
            db.store.materialize_snapshot(None).await.unwrap().revision,
        )
        .await
        .unwrap();
    assert_eq!(verify.summary.changed_targets, 0);
    assert_eq!(verify.base_revision_id, None);
    // Another process instance and duplicate online polls cannot create a second bootstrap.
    let reopened = PgStore::connect(&db.url).await.unwrap();
    online(&db, "new").await;
    reopened.process_node_initialization().await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM deployments")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(count, 2);
}

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1 and PostgreSQL"]
async fn node_initialization_serializes_concurrent_enrollment_without_treating_it_as_backlog() {
    let Some(db) = start().await else { return };
    enroll(&db, "first", false).await;
    enroll(&db, "second", false).await;
    online(&db, "first").await;
    online(&db, "second").await;
    let (a, b) = tokio::join!(
        db.store.process_node_initialization(),
        db.store.process_node_initialization()
    );
    a.unwrap();
    b.unwrap();
    let first = db
        .store
        .claim_desired_for_node("first")
        .await
        .unwrap()
        .unwrap();
    assert!(db
        .store
        .claim_desired_for_node("second")
        .await
        .unwrap()
        .is_none());
    db.store
        .report_target_result(applied_report(&first))
        .await
        .unwrap();
    sqlx::query("UPDATE jobs SET run_after=now() WHERE kind='node-initialization'")
        .execute(db.pool())
        .await
        .unwrap();
    let second = complete(&db, "second").await;
    assert_ne!(first.deployment_id, second);
    assert_eq!(
        status(&db, "first").await.state,
        NodeInitializationState::Succeeded
    );
    assert_eq!(
        status(&db, "second").await.state,
        NodeInitializationState::Succeeded
    );
}

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1 and PostgreSQL"]
async fn node_initialization_rejects_preexisting_configuration_backlog() {
    let Some(db) = TestPg::start_if_enabled().await else {
        return;
    };
    db.store.migrate().await.unwrap();
    insert_minimal_fixture(db.pool()).await;
    enroll(&db, "new", false).await;
    online(&db, "new").await;
    db.store.process_node_initialization().await.unwrap();
    let state = status(&db, "new").await;
    assert_eq!(state.state, NodeInitializationState::Manual);
    assert!(state.reason.unwrap().contains("其他机器"));
    assert_eq!(state.deployment_id, None);
}

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1 and PostgreSQL"]
async fn node_initialization_rechecks_changes_committed_while_installing() {
    for change_new in [true, false] {
        let Some(db) = start().await else { return };
        enroll(&db, "old", false).await;
        complete(&db, "old").await;
        enroll(&db, "new", false).await;
        db.store
            .update_node(
                &system_admin(),
                if change_new { "new" } else { "old" },
                UpdateNodeRequest {
                    dns: Some(Dns::Servers(vec!["9.9.9.9".to_owned()])),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        online(&db, "new").await;
        db.store.process_node_initialization().await.unwrap();
        assert_eq!(
            status(&db, "new").await.state,
            NodeInitializationState::Manual
        );
        assert!(db
            .store
            .claim_desired_for_node("new")
            .await
            .unwrap()
            .is_none());
    }
}

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1 and PostgreSQL"]
async fn node_initialization_with_wireguard_enabled_requires_manual_publication() {
    let Some(db) = start().await else { return };
    enroll(&db, "new", true).await;
    online(&db, "new").await;
    db.store.process_node_initialization().await.unwrap();
    let state = status(&db, "new").await;
    assert_eq!(state.state, NodeInitializationState::Manual);
    assert!(state.reason.unwrap().contains("WireGuard"));
}

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1 and PostgreSQL"]
async fn node_initialization_tracks_manual_takeover_and_does_not_duplicate_it() {
    let Some(db) = start().await else { return };
    let node = enroll(&db, "new", false).await;
    let manual = db
        .store
        .create_deployment(
            &system_admin(),
            create_deployment_request(node.revision_id, "manual"),
        )
        .await
        .unwrap();
    online(&db, "new").await;
    db.store.process_node_initialization().await.unwrap();
    assert_eq!(
        status(&db, "new").await.deployment_id,
        Some(manual.deployment_id)
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM deployments")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(count, 1);
    db.store
        .confirm_deployment_wave(&system_admin(), manual.deployment_id, 1, None)
        .await
        .unwrap();
    let desired = db
        .store
        .claim_desired_for_node("new")
        .await
        .unwrap()
        .unwrap();
    db.store
        .report_target_result(applied_report(&desired))
        .await
        .unwrap();
    let detail = db
        .store
        .deployment_detail(&system_admin(), manual.deployment_id, false)
        .await
        .unwrap();
    assert_eq!(detail.activation_status, "activated");
}

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1 and PostgreSQL"]
async fn node_initialization_manual_takeover_remains_backlog_for_later_enrollment() {
    let Some(db) = start().await else { return };
    let node = enroll(&db, "new", false).await;
    db.store
        .create_deployment(
            &system_admin(),
            create_deployment_request(node.revision_id, "manual"),
        )
        .await
        .unwrap();
    online(&db, "new").await;
    db.store.process_node_initialization().await.unwrap();
    enroll(&db, "next", false).await;
    assert_eq!(
        status(&db, "next").await.state,
        NodeInitializationState::Manual,
        "following a manual order must not classify it as an automatic sibling"
    );
}

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1 and PostgreSQL"]
async fn node_initialization_failed_receipt_is_visible_and_never_recreates_the_release() {
    let Some(db) = start().await else { return };
    enroll(&db, "new", false).await;
    online(&db, "new").await;
    db.store.process_node_initialization().await.unwrap();
    let desired = db
        .store
        .claim_desired_for_node("new")
        .await
        .unwrap()
        .unwrap();
    db.store
        .report_target_result(failed_recovered_report(&desired))
        .await
        .unwrap();
    db.store.process_node_initialization().await.unwrap();
    let state = status(&db, "new").await;
    assert_eq!(state.state, NodeInitializationState::Failed);
    assert_eq!(state.deployment_id, Some(desired.deployment_id));
    db.store.process_node_initialization().await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM deployments")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1 and PostgreSQL"]
async fn node_initialization_recovers_after_console_restart_and_ignores_token_rotation() {
    let Some(db) = start().await else { return };
    enroll(&db, "new", false).await;
    online(&db, "new").await;
    let reopened = PgStore::connect(&db.url).await.unwrap();
    reopened.process_node_initialization().await.unwrap();
    let desired = db
        .store
        .claim_desired_for_node("new")
        .await
        .unwrap()
        .unwrap();
    db.store
        .report_target_result(applied_report(&desired))
        .await
        .unwrap();
    db.store.reissue_node_token("new").await.unwrap();
    reopened.process_node_initialization().await.unwrap();
    let jobs: i64 =
        sqlx::query_scalar("SELECT count(*) FROM jobs WHERE kind='node-initialization'")
            .fetch_one(db.pool())
            .await
            .unwrap();
    assert_eq!(jobs, 1);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM deployments")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn node_initialization_provision_defaults_wireguard_off() {
    let mut document = serde_json::to_value(provision_node_request("new")).unwrap();
    document.as_object_mut().unwrap().remove("overlay");
    let request: ProvisionNodeRequest = serde_json::from_value(document).unwrap();
    assert!(!request.overlay);
}

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1 and PostgreSQL"]
async fn node_initialization_waits_for_a_compatible_agent_and_recovers_after_upgrade() {
    let Some(db) = start().await else { return };
    enroll(&db, "new", false).await;
    db.store
        .record_node_poll_with_protocol("new", Some(AGENT_BUILD), Some(1))
        .await
        .unwrap();
    db.store.process_node_initialization().await.unwrap();
    let state = status(&db, "new").await;
    assert_eq!(state.state, NodeInitializationState::Manual);
    assert!(state.reason.unwrap().contains("协议"));
    assert_eq!(state.deployment_id, None);
    complete(&db, "new").await;
    assert_eq!(
        status(&db, "new").await.state,
        NodeInitializationState::Succeeded
    );
}

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1 and PostgreSQL"]
async fn node_initialization_sibling_tasks_cannot_hide_business_edits() {
    let Some(db) = start().await else { return };
    enroll(&db, "first", false).await;
    db.store
        .update_node(
            &system_admin(),
            "first",
            UpdateNodeRequest {
                dns: Some(Dns::Servers(vec!["9.9.9.9".to_owned()])),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    enroll(&db, "second", false).await;
    assert_eq!(
        status(&db, "second").await.state,
        NodeInitializationState::Manual
    );
    online(&db, "first").await;
    db.store.process_node_initialization().await.unwrap();
    assert_eq!(
        status(&db, "first").await.state,
        NodeInitializationState::Manual
    );
}

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1 and PostgreSQL"]
async fn node_initialization_lifecycle_change_fences_the_original_intent() {
    let Some(db) = start().await else { return };
    enroll(&db, "new", false).await;
    sqlx::query("UPDATE node_lifecycle_state SET lifecycle_epoch=1 WHERE node_id='new'")
        .execute(db.pool())
        .await
        .unwrap();
    online(&db, "new").await;
    db.store.process_node_initialization().await.unwrap();
    assert_eq!(
        status(&db, "new").await.state,
        NodeInitializationState::Manual
    );
    assert!(db
        .store
        .claim_desired_for_node("new")
        .await
        .unwrap()
        .is_none());
}
