use super::*;

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1 and PostgreSQL"]
async fn initialization_enables_online_sources_and_preserves_saved_opt_out() {
    let Some(db) = TestPg::start_if_enabled().await else {
        return;
    };
    db.store.migrate().await.unwrap();
    let before = db.store.materialize_snapshot(None).await.unwrap();
    db.store
        .init_system(brocade_store::SystemInitRequest {
            operator_id: "admin".to_owned(),
            display_name: "管理员".to_owned(),
            password: "test-admin-password".to_owned(),
            root_tenant: "platform".to_owned(),
        })
        .await
        .unwrap();
    assert!(db.store.settings().await.unwrap().stats_user_online);
    let initialized = db.store.materialize_snapshot(None).await.unwrap();
    assert!(initialized.settings.stats_user_online);
    assert!(initialized.revision > before.revision);
    assert_eq!(
        db.store
            .materialize_snapshot(Some(before.revision))
            .await
            .unwrap()
            .settings
            .stats_user_online,
        before.settings.stats_user_online,
        "initialization must preserve the historical online-source setting"
    );

    let mut settings = db.store.settings().await.unwrap();
    settings.stats_user_online = false;
    let saved = db
        .store
        .update_settings(&system_admin(), settings)
        .await
        .unwrap();
    db.store.migrate().await.unwrap();
    assert!(!db.store.settings().await.unwrap().stats_user_online);
    let reopened = db.store.materialize_snapshot(None).await.unwrap();
    assert!(!reopened.settings.stats_user_online);
    assert_eq!(reopened.revision, saved.revision_id);
    assert!(
        db.store
            .materialize_snapshot(Some(initialized.revision))
            .await
            .unwrap()
            .settings
            .stats_user_online
    );
}
