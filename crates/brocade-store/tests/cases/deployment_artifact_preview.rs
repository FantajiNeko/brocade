use super::*;

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1 and PostgreSQL"]
async fn deployment_artifact_preview_uses_empty_new_baseline_and_acknowledged_old_bytes() {
    let Some(db) = TestPg::start_if_enabled().await else {
        return;
    };
    db.store.migrate().await.unwrap();
    insert_minimal_fixture(db.pool()).await;

    let fresh = db
        .store
        .plan_deployment_artifacts(&system_admin(), 1, true)
        .await
        .unwrap();
    let node = fresh.iter().find(|n| n.node_id == "n1").unwrap();
    for kind in ["phantun", "wireguard", "xray", "hy2_port_hop"] {
        assert_eq!(
            node.observed_before.as_ref().unwrap()[kind]["state"],
            "absent"
        );
    }
    let new_content = node.desired_structure["xray"]["content"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(!new_content.is_empty());
    let original_plan = db.store.plan_deployment(&system_admin(), 1).await.unwrap();
    insert_matching_applied_state(db.pool(), "n1", find_target(&original_plan, "n1")).await;
    let order = db
        .store
        .create_deployment(
            &system_admin(),
            create_deployment_request(1, "artifact-preview-baseline"),
        )
        .await;
    // All targets now match, so no no-op deployment is created just to build a baseline.
    assert!(order.is_err());

    let old_content = "{\"oldCompiler\":true}\n";
    let old_sha = brocade_core::hash::sha256_hex(old_content.as_bytes());
    sqlx::query("INSERT INTO artifact_blobs (sha256,content,byte_len) VALUES ($1,$2,$3)")
        .bind(&old_sha)
        .bind(old_content)
        .bind(i32::try_from(old_content.len()).unwrap())
        .execute(db.pool())
        .await
        .unwrap();
    sqlx::query("UPDATE node_applied_state SET xray_sha256=$1 WHERE node_id='n1'")
        .bind(&old_sha)
        .execute(db.pool())
        .await
        .unwrap();

    let changed = db
        .store
        .plan_deployment_artifacts(&system_admin(), 1, true)
        .await
        .unwrap();
    let node = changed.iter().find(|n| n.node_id == "n1").unwrap();
    assert_eq!(
        node.observed_before.as_ref().unwrap()["xray"]["content"],
        old_content
    );
    assert_eq!(
        node.observed_before.as_ref().unwrap()["xray"]["sha256"],
        old_sha
    );
    assert_eq!(node.desired_structure["xray"]["content"], new_content);

    sqlx::query("DELETE FROM artifact_blobs WHERE sha256=$1")
        .bind(&old_sha)
        .execute(db.pool())
        .await
        .unwrap();
    let missing = db
        .store
        .plan_deployment_artifacts(&system_admin(), 1, true)
        .await
        .unwrap();
    let before = &missing
        .iter()
        .find(|n| n.node_id == "n1")
        .unwrap()
        .observed_before
        .as_ref()
        .unwrap()["xray"];
    assert_eq!(before["state"], "present");
    assert_eq!(before["sha256"], old_sha);
    assert!(
        before.get("content").is_none(),
        "missing old content must not become an empty baseline"
    );
    let orders: i64 = sqlx::query_scalar("SELECT count(*) FROM deployments")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(orders, 0, "artifact preview is read-only");
}

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1 and PostgreSQL"]
async fn deployment_artifact_preview_enforces_scope_and_source_permission() {
    let Some(db) = TestPg::start_if_enabled().await else {
        return;
    };
    db.store.migrate().await.unwrap();
    insert_minimal_fixture(db.pool()).await;
    sqlx::query("INSERT INTO tenants (id,name) VALUES ('platform.other','Other')")
        .execute(db.pool())
        .await
        .unwrap();
    insert_basic_node(
        db.pool(),
        "other-node",
        "platform.other",
        "10.66.0.2",
        51821,
    )
    .await;
    let actor = publisher("platform.acme");
    let scoped = db
        .store
        .plan_deployment_artifacts(&actor, 1, false)
        .await
        .unwrap();
    assert_eq!(scoped.len(), 1);
    assert_eq!(scoped[0].node_id, "n1");
    for artifact in scoped[0].desired_structure.as_object().unwrap().values() {
        assert!(artifact.get("content").is_none());
    }
    assert!(matches!(
        db.store.plan_deployment_artifacts(&actor, 1, true).await,
        Err(StoreError::Forbidden(_))
    ));
}
