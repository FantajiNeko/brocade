use super::*;
use sha2::{Digest, Sha384};
use std::{
    io::Write,
    process::{Command, Stdio},
};

#[tokio::test]
#[ignore = "requires BROCADE_RUN_PG_TESTS=1, Docker and PostgreSQL"]
async fn compatibility_limits_preserve_data_and_migration_records_and_are_repeatable() {
    let Some(db) = TestPg::start_if_enabled().await else {
        return;
    };
    db.store.migrate().await.unwrap();
    insert_minimal_fixture(db.pool()).await;
    let definitions_sql = "SELECT conname::text,pg_get_constraintdef(oid) FROM pg_constraint
        WHERE conrelid='control_state'::regclass AND conname IN
        ('control_state_geodata_cron_shape','control_state_reality_max_time_diff_ms_range') ORDER BY conname";
    let expected_definitions: Vec<(String, String)> = sqlx::query_as(definitions_sql)
        .fetch_all(db.pool())
        .await
        .unwrap();
    assert_eq!(expected_definitions.len(), 2);
    sqlx::raw_sql(r"
        ALTER TABLE control_state DROP CONSTRAINT control_state_geodata_cron_shape;
        ALTER TABLE control_state ADD CONSTRAINT control_state_geodata_cron_shape
            CHECK (geodata_cron ~ '^((CRON_)?TZ=\S+\s+)?\S+(\s+\S+){4}$');
        ALTER TABLE control_state DROP CONSTRAINT control_state_reality_max_time_diff_ms_range;
        ALTER TABLE control_state ADD CONSTRAINT control_state_reality_max_time_diff_ms_range
            CHECK (reality_max_time_diff_ms IS NULL OR reality_max_time_diff_ms BETWEEN 0 AND 86400000);
    ").execute(db.pool()).await.unwrap();
    let original: serde_json::Value =
        sqlx::query_scalar("SELECT to_jsonb(control_state) FROM control_state")
            .fetch_one(db.pool())
            .await
            .unwrap();
    let checksum: Vec<u8> =
        sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version=1")
            .fetch_one(db.pool())
            .await
            .unwrap();
    for _ in 0..2 {
        let mut child = Command::new("docker")
            .args([
                "exec",
                "-i",
                db._container.id(),
                "psql",
                "-U",
                "postgres",
                "-d",
                "postgres",
                "-v",
                "app_role=postgres",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(include_bytes!(
                "../../../../scripts/compat-validation-limits.sql"
            ))
            .unwrap();
        let result = child.wait_with_output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
    let after: serde_json::Value =
        sqlx::query_scalar("SELECT to_jsonb(control_state) FROM control_state")
            .fetch_one(db.pool())
            .await
            .unwrap();
    assert_eq!(after, original);
    let definitions: Vec<(String, String)> = sqlx::query_as(definitions_sql)
        .fetch_all(db.pool())
        .await
        .unwrap();
    assert_eq!(
        definitions, expected_definitions,
        "upgraded CHECKs match a fresh installation"
    );
    let after_checksum: Vec<u8> =
        sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version=1")
            .fetch_one(db.pool())
            .await
            .unwrap();
    assert_eq!(
        checksum, after_checksum,
        "the compatibility script must not rewrite migration history"
    );
    sqlx::query(
        "UPDATE control_state SET geodata_cron='@daily',reality_max_time_diff_ms=$1 WHERE id=TRUE",
    )
    .bind(i64::try_from(brocade_core::model::MAX_REALITY_TIME_DIFF_MS).unwrap())
    .execute(db.pool())
    .await
    .unwrap();
    assert!(
        sqlx::query("UPDATE control_state SET reality_max_time_diff_ms=$1 WHERE id=TRUE")
            .bind(i64::try_from(brocade_core::model::MAX_REALITY_TIME_DIFF_MS + 1).unwrap())
            .execute(db.pool())
            .await
            .is_err()
    );

    // The fixture already has the current record, just like the existing deployment workflow
    // after schema comparison and its separate, operator-owned checksum step.
    assert_eq!(
        checksum,
        Sha384::digest(include_bytes!("../../migrations/0001_init.sql")).as_slice()
    );
    db.store.migrate().await.unwrap();
    assert_eq!(db.store.settings().await.unwrap().geodata.cron, "@daily");
}
