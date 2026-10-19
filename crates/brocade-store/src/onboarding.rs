use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Row, Transaction};

use crate::{AdminContext, Result, StoreError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OnboardingStatus {
    Active,
    Complete,
    NotApplicable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OnboardingState {
    pub status: OnboardingStatus,
    pub root_tenant_id: Option<String>,
    pub started_at: Option<String>,
    pub node_id: Option<String>,
    pub app_id: Option<String>,
    pub chain_id: Option<String>,
    pub ingress_id: Option<String>,
    pub user_tenant_id: Option<String>,
    pub user_id: Option<String>,
    pub target_revision_id: Option<u64>,
    pub deployment_id: Option<u64>,
    pub completed_at: Option<String>,
}

impl OnboardingState {
    fn not_applicable() -> Self {
        Self {
            status: OnboardingStatus::NotApplicable,
            root_tenant_id: None,
            started_at: None,
            node_id: None,
            app_id: None,
            chain_id: None,
            ingress_id: None,
            user_tenant_id: None,
            user_id: None,
            target_revision_id: None,
            deployment_id: None,
            completed_at: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "step", rename_all = "kebab-case")]
pub enum OnboardingCheckpointRequest {
    Node {
        node_id: String,
    },
    Model {
        app_id: String,
        chain_id: String,
        ingress_id: String,
        user_tenant_id: String,
        user_id: String,
        target_revision_id: u64,
    },
    Deployment {
        deployment_id: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnboardingProbeEvidence {
    pub probe_id: String,
    pub item_id: String,
    pub serving_generation: u64,
    pub protocol: String,
    pub family: String,
}

pub(crate) async fn start_tx(
    tx: &mut Transaction<'_, Postgres>,
    actor: &AdminContext,
    root_tenant_id: &str,
) -> Result<()> {
    require_system_admin(actor)?;
    sqlx::query(
        "INSERT INTO first_run_onboarding (id, root_tenant_id, started_by)
         VALUES (TRUE, $1, $2)",
    )
    .bind(root_tenant_id)
    .bind(actor.operator_id())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn status(pool: &PgPool, actor: &AdminContext) -> Result<OnboardingStatus> {
    if !actor.is_system_admin() {
        return Ok(OnboardingStatus::NotApplicable);
    }
    let completed = sqlx::query_scalar::<_, Option<bool>>(
        "SELECT completed_at IS NOT NULL FROM first_run_onboarding WHERE id = TRUE",
    )
    .fetch_optional(pool)
    .await?
    .flatten();
    Ok(match completed {
        Some(true) => OnboardingStatus::Complete,
        Some(false) => OnboardingStatus::Active,
        None => OnboardingStatus::NotApplicable,
    })
}

pub async fn get(pool: &PgPool, actor: &AdminContext) -> Result<OnboardingState> {
    require_system_admin(actor)?;
    let row = sqlx::query(
        "SELECT root_tenant_id,
                started_at::text AS started_at,
                node_id, app_id, chain_id, ingress_id,
                user_tenant_id, user_id,
                target_revision_id, deployment_id,
                completed_at::text AS completed_at
           FROM first_run_onboarding
          WHERE id = TRUE",
    )
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(OnboardingState::not_applicable());
    };
    state_from_row(&row)
}

pub async fn checkpoint(
    pool: &PgPool,
    actor: &AdminContext,
    request: OnboardingCheckpointRequest,
) -> Result<OnboardingState> {
    require_system_admin(actor)?;
    let mut tx = pool.begin().await?;
    let current = lock_active(&mut tx).await?;
    match request {
        OnboardingCheckpointRequest::Node { node_id } => {
            if current.target_revision_id.is_some() {
                return Err(StoreError::Conflict(
                    "the onboarding machine cannot change after its model is committed".to_owned(),
                ));
            }
            if current
                .node_id
                .as_deref()
                .is_some_and(|existing| existing != node_id)
            {
                return Err(StoreError::Conflict(
                    "a different onboarding machine is already checkpointed".to_owned(),
                ));
            }
            let valid = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS (
                    SELECT 1 FROM nodes WHERE id = $1 AND tenant_id = $2
                 )",
            )
            .bind(&node_id)
            .bind(&current.root_tenant_id)
            .fetch_one(&mut *tx)
            .await?;
            if !valid {
                return Err(StoreError::InvalidData(format!(
                    "onboarding node {node_id} is not in the root tenant"
                )));
            }
            sqlx::query(
                "UPDATE first_run_onboarding
                    SET node_id = $1
                  WHERE id = TRUE",
            )
            .bind(node_id)
            .execute(&mut *tx)
            .await?;
        }
        OnboardingCheckpointRequest::Model {
            app_id,
            chain_id,
            ingress_id,
            user_tenant_id,
            user_id,
            target_revision_id,
        } => {
            if current.deployment_id.is_some() {
                return Err(StoreError::Conflict(
                    "the onboarding model cannot change after deployment starts".to_owned(),
                ));
            }
            let node_id = current.node_id.ok_or_else(|| {
                StoreError::Conflict("checkpoint the first machine before its model".to_owned())
            })?;
            if user_tenant_id != current.root_tenant_id {
                return Err(StoreError::InvalidData(
                    "the first user must belong to the root tenant".to_owned(),
                ));
            }
            let target_revision = u64_to_i64(target_revision_id, "target_revision_id")?;
            let valid = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS (
                    SELECT 1
                      FROM control_state cs
                      JOIN chains c ON c.id = $2 AND c.app_id = $1
                      JOIN ingresses i ON i.id = $3 AND i.app_id = $1
                           AND i.chain_id = $2 AND i.node_id = $4
                      JOIN users u ON u.tenant_id = $5 AND u.id = $6
                      JOIN grants g ON g.app_id = $1 AND g.ingress_id = $3
                           AND g.tenant_id = $5 AND g.user_id = $6
                     WHERE cs.id = TRUE AND cs.current_revision = $7
                 )",
            )
            .bind(&app_id)
            .bind(&chain_id)
            .bind(&ingress_id)
            .bind(&node_id)
            .bind(&user_tenant_id)
            .bind(&user_id)
            .bind(target_revision)
            .fetch_one(&mut *tx)
            .await?;
            if !valid {
                return Err(StoreError::Conflict(
                    "onboarding model is not the current committed chain, user and grant"
                        .to_owned(),
                ));
            }
            sqlx::query(
                "UPDATE first_run_onboarding
                    SET app_id = $1,
                        chain_id = $2,
                        ingress_id = $3,
                        user_tenant_id = $4,
                        user_id = $5,
                        target_revision_id = $6,
                        deployment_id = NULL
                  WHERE id = TRUE",
            )
            .bind(app_id)
            .bind(chain_id)
            .bind(ingress_id)
            .bind(user_tenant_id)
            .bind(user_id)
            .bind(target_revision)
            .execute(&mut *tx)
            .await?;
        }
        OnboardingCheckpointRequest::Deployment { deployment_id } => {
            let target_revision = current.target_revision_id.ok_or_else(|| {
                StoreError::Conflict("checkpoint the first model before deployment".to_owned())
            })?;
            let deployment = u64_to_i64(deployment_id, "deployment_id")?;
            let valid = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS (
                    SELECT 1 FROM deployments
                     WHERE id = $1 AND revision_id = $2 AND kind = 'config'
                       AND status NOT IN ('failed', 'canceled')
                 )",
            )
            .bind(deployment)
            .bind(target_revision)
            .fetch_one(&mut *tx)
            .await?;
            if !valid {
                return Err(StoreError::Conflict(
                    "deployment does not publish the onboarding revision".to_owned(),
                ));
            }
            sqlx::query(
                "UPDATE first_run_onboarding
                    SET deployment_id = $1
                  WHERE id = TRUE",
            )
            .bind(deployment)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    get(pool, actor).await
}

pub async fn complete(
    pool: &PgPool,
    actor: &AdminContext,
    evidence: OnboardingProbeEvidence,
) -> Result<OnboardingState> {
    require_system_admin(actor)?;
    let generation = u64_to_i64(evidence.serving_generation, "serving_generation")?;
    let changed = sqlx::query(
        "UPDATE first_run_onboarding o
            SET completed_at = now(),
                completed_by = $1,
                probe_id = $2,
                probe_item_id = $3,
                probe_serving_generation = $4,
                probe_protocol = $5,
                probe_family = $6
          WHERE o.id = TRUE
            AND o.completed_at IS NULL
            AND o.deployment_id IS NOT NULL
            AND EXISTS (
                SELECT 1 FROM subscription_serving_state s
                 WHERE s.id = TRUE AND s.generation = $7
            )
            AND EXISTS (
                SELECT 1 FROM deployments d
                 WHERE d.id = o.deployment_id
                   AND d.revision_id = o.target_revision_id
                   AND d.kind = 'config'
                   AND d.activation_status = 'activated'
            )",
    )
    .bind(actor.operator_id())
    .bind(evidence.probe_id)
    .bind(evidence.item_id)
    .bind(generation)
    .bind(evidence.protocol)
    .bind(evidence.family)
    .bind(generation)
    .execute(pool)
    .await?
    .rows_affected();
    if changed == 0 {
        let current = get(pool, actor).await?;
        if current.status != OnboardingStatus::Complete {
            return Err(StoreError::Conflict(
                "the onboarding deployment or Serving authorization has changed".to_owned(),
            ));
        }
    }
    get(pool, actor).await
}

struct LockedState {
    root_tenant_id: String,
    node_id: Option<String>,
    target_revision_id: Option<i64>,
    deployment_id: Option<i64>,
}

async fn lock_active(tx: &mut Transaction<'_, Postgres>) -> Result<LockedState> {
    let row = sqlx::query(
        "SELECT root_tenant_id, node_id, target_revision_id, deployment_id,
                completed_at IS NOT NULL AS completed
           FROM first_run_onboarding
          WHERE id = TRUE
          FOR UPDATE",
    )
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| StoreError::NotFound("first-run onboarding is not applicable".to_owned()))?;
    if row.try_get::<bool, _>("completed")? {
        return Err(StoreError::Conflict(
            "first-run onboarding is already complete".to_owned(),
        ));
    }
    Ok(LockedState {
        root_tenant_id: row.try_get("root_tenant_id")?,
        node_id: row.try_get("node_id")?,
        target_revision_id: row.try_get("target_revision_id")?,
        deployment_id: row.try_get("deployment_id")?,
    })
}

fn state_from_row(row: &sqlx::postgres::PgRow) -> Result<OnboardingState> {
    let completed_at: Option<String> = row.try_get("completed_at")?;
    Ok(OnboardingState {
        status: if completed_at.is_some() {
            OnboardingStatus::Complete
        } else {
            OnboardingStatus::Active
        },
        root_tenant_id: Some(row.try_get("root_tenant_id")?),
        started_at: row.try_get("started_at")?,
        node_id: row.try_get("node_id")?,
        app_id: row.try_get("app_id")?,
        chain_id: row.try_get("chain_id")?,
        ingress_id: row.try_get("ingress_id")?,
        user_tenant_id: row.try_get("user_tenant_id")?,
        user_id: row.try_get("user_id")?,
        target_revision_id: optional_u64(row.try_get("target_revision_id")?, "target_revision_id")?,
        deployment_id: optional_u64(row.try_get("deployment_id")?, "deployment_id")?,
        completed_at,
    })
}

fn require_system_admin(actor: &AdminContext) -> Result<()> {
    if actor.is_system_admin() {
        Ok(())
    } else {
        Err(StoreError::Forbidden(
            "first-run onboarding requires system-admin".to_owned(),
        ))
    }
}

fn u64_to_i64(value: u64, field: &str) -> Result<i64> {
    i64::try_from(value)
        .map_err(|_| StoreError::InvalidData(format!("{field} exceeds BIGINT range")))
}

fn optional_u64(value: Option<i64>, field: &str) -> Result<Option<u64>> {
    value
        .map(|value| {
            u64::try_from(value)
                .map_err(|_| StoreError::InvalidData(format!("{field} is negative")))
        })
        .transpose()
}
