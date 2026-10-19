//! Bounded optional observations: independent lock/transaction, never a billing receipt.
use crate::{AdminContext, Result, StoreError};
use brocade_deployment::other_domain::{
    valid_domain, OtherDomainPolicy, OtherDomainReport, UserOtherDomainRow, UserOtherDomains,
    OTHER_DOMAIN_MAX_ROWS, OTHER_DOMAIN_VERSION,
};
use brocade_deployment::site_usage::SiteUsagePeriod;
use brocade_deployment::sniffing_failed::{
    valid_target, SniffingFailedPolicy, SniffingFailedReport, UserSniffingFailedRow,
    UserSniffingFailedTargets,
};
use sqlx::{PgPool, Row};
use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet},
};

#[derive(Clone, Copy)]
enum DetailKind {
    Domain,
    FailedTarget,
}
impl DetailKind {
    // Only private, fixed SQL identifiers are selected here; every external value stays bound.
    fn sql(self, source: &'static str) -> Cow<'static, str> {
        match self {
            Self::Domain => Cow::Borrowed(source),
            Self::FailedTarget => Cow::Owned(
                source
                    .replace("other_domain", "sniffing_failed")
                    .replace("domain", "target")
                    .replace("1481785690", "1481785691"),
            ),
        }
    }
    fn key_column(self) -> &'static str {
        match self {
            Self::Domain => "domain",
            Self::FailedTarget => "target",
        }
    }
    fn valid_key(self, value: &str) -> bool {
        match self {
            Self::Domain => valid_domain(value),
            Self::FailedTarget => valid_target(value),
        }
    }
    fn decode_policy(self, value: serde_json::Value) -> Result<OtherDomainPolicy> {
        let policy = match self {
            Self::Domain => serde_json::from_value(value)?,
            Self::FailedTarget => serde_json::from_value::<SniffingFailedPolicy>(value)?.budget(),
        };
        policy
            .validate()
            .map_err(|e| StoreError::InvalidData(e.into()))?;
        Ok(policy)
    }
    fn encode_policy(self, value: OtherDomainPolicy) -> Result<serde_json::Value> {
        Ok(match self {
            Self::Domain => serde_json::to_value(value)?,
            Self::FailedTarget => serde_json::to_value(SniffingFailedPolicy::from_budget(value))?,
        })
    }
}

pub(crate) async fn policy(pool: &PgPool) -> Result<OtherDomainPolicy> {
    policy_for(pool, DetailKind::Domain).await
}
async fn policy_for(pool: &PgPool, kind: DetailKind) -> Result<OtherDomainPolicy> {
    let value = sqlx::query_scalar(
        &kind.sql("SELECT other_domain_policy FROM control_state WHERE id=TRUE"),
    )
    .fetch_one(pool)
    .await?;
    let policy = kind.decode_policy(value)?;
    policy
        .validate()
        .map_err(|e| StoreError::InvalidData(e.into()))?;
    Ok(policy)
}
pub(crate) async fn update_policy(
    pool: &PgPool,
    actor: &AdminContext,
    value: OtherDomainPolicy,
) -> Result<OtherDomainPolicy> {
    update_policy_for(pool, actor, value, DetailKind::Domain).await
}
async fn update_policy_for(
    pool: &PgPool,
    actor: &AdminContext,
    value: OtherDomainPolicy,
    kind: DetailKind,
) -> Result<OtherDomainPolicy> {
    if !actor.is_system_admin() {
        return Err(StoreError::Forbidden(
            "only system-admin can change domain observations".into(),
        ));
    }
    value
        .validate()
        .map_err(|e| StoreError::InvalidData(e.into()))?;
    sqlx::query(&kind.sql("UPDATE control_state SET other_domain_policy=$1 WHERE id=TRUE"))
        .bind(kind.encode_policy(value)?)
        .execute(pool)
        .await?;
    Ok(value)
}

#[cfg(test)]
fn validate(report: &OtherDomainReport, now: i64) -> Result<()> {
    validate_for(report, now, DetailKind::Domain)
}
fn validate_for(report: &OtherDomainReport, now: i64, kind: DetailKind) -> Result<()> {
    let mut seen = BTreeSet::new();
    if report.version != OTHER_DOMAIN_VERSION
        || report.epoch.len() != 32
        || !report.epoch.bytes().all(|c| c.is_ascii_hexdigit())
        || report.counters.len() > OTHER_DOMAIN_MAX_ROWS
        || report.read_at_unix_secs > now + 60
        || report.read_at_unix_secs < now - 600
        || report.activation_unix_secs <= 0
        || report.activation_unix_secs > report.read_at_unix_secs
        || report.usage_generation_id <= 0
    {
        return Err(StoreError::InvalidData(
            "invalid domain observation envelope".into(),
        ));
    }
    let hour = report.read_at_unix_secs / 3600 * 3600;
    for row in &report.counters {
        if row.label.is_empty()
            || row.label.len() > 256
            || !kind.valid_key(&row.domain)
            || ![hour, hour - 3600].contains(&row.bucket)
            || row.uplink_bytes > i64::MAX as u64
            || row.downlink_bytes > i64::MAX as u64
            || !seen.insert((row.bucket, &row.label, &row.domain))
        {
            return Err(StoreError::InvalidData(
                "invalid or duplicate domain observation row".into(),
            ));
        }
    }
    Ok(())
}

pub(crate) async fn record(pool: &PgPool, node: &str, report: OtherDomainReport) -> Result<()> {
    record_for(pool, node, report, DetailKind::Domain).await
}
async fn record_for(
    pool: &PgPool,
    node: &str,
    report: OtherDomainReport,
    kind: DetailKind,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query(&kind.sql("SET LOCAL statement_timeout='10s'"))
        .execute(&mut *tx)
        .await?;
    // This optional path neither acquires billing's row lock nor waits on another domain report.
    let locked: bool =
        sqlx::query_scalar(&kind.sql("SELECT pg_try_advisory_xact_lock(1481785690,hashtext($1))"))
            .bind(node)
            .fetch_one(&mut *tx)
            .await?;
    if !locked {
        return Err(StoreError::InvalidData(
            "domain observation busy; retry later".into(),
        ));
    }
    let now: i64 = sqlx::query_scalar(&kind.sql("SELECT extract(epoch FROM now())::bigint"))
        .fetch_one(&mut *tx)
        .await?;
    validate_for(&report, now, kind)?;
    let policy: serde_json::Value = sqlx::query_scalar(
        &kind.sql("SELECT other_domain_policy FROM control_state WHERE id=TRUE"),
    )
    .fetch_one(&mut *tx)
    .await?;
    let policy = kind.decode_policy(policy)?;
    policy
        .validate()
        .map_err(|e| StoreError::InvalidData(e.into()))?;
    if !policy.enabled {
        return Err(StoreError::Forbidden(
            "domain observations are disabled".into(),
        ));
    }
    let previous = sqlx::query(&kind.sql(
        "SELECT epoch,read_at,observed_since,limited FROM node_other_domain_state WHERE node_id=$1",
    ))
    .bind(node)
    .fetch_optional(&mut *tx)
    .await?;
    if previous
        .as_ref()
        .is_some_and(|p| p.get::<i64, _>("read_at") >= report.read_at_unix_secs)
    {
        tx.commit().await?;
        return Ok(());
    }
    if previous.as_ref().is_some_and(|p| {
        p.get::<String, _>("epoch") != report.epoch
            && p.get::<i64, _>("observed_since") > report.activation_unix_secs
    }) {
        return Err(StoreError::InvalidData(
            "stale domain observation epoch".into(),
        ));
    }
    let owners =
        crate::usage::other_domain_owners(&mut tx, node, report.usage_generation_id).await?;
    let old=sqlx::query(&kind.sql("SELECT bucket,label,domain,uplink_bytes,downlink_bytes FROM other_domain_counter_heads WHERE node_id=$1 AND epoch=$2 AND bucket >= $3"))
        .bind(node).bind(&report.epoch).bind(report.read_at_unix_secs/3600*3600-3600).fetch_all(&mut *tx).await?
        .into_iter().map(|r| ((r.get::<i64,_>("bucket"),r.get::<String,_>("label"),r.get::<String, _>(kind.key_column())),(r.get::<i64,_>("uplink_bytes"),r.get::<i64,_>("downlink_bytes")))).collect::<BTreeMap<_,_>>();
    let mut limited = report.limited;
    let same_epoch = previous
        .as_ref()
        .is_some_and(|p| p.get::<String, _>("epoch") == report.epoch);
    let since = if same_epoch {
        previous
            .as_ref()
            .map(|p| p.get("observed_since"))
            .unwrap_or(report.activation_unix_secs)
    } else {
        report.activation_unix_secs
    };
    if let Some(p) = &previous {
        limited |= same_epoch
            && (p.get::<bool, _>("limited")
                || report.read_at_unix_secs - p.get::<i64, _>("read_at") > 3600);
    }
    // Arrays are bounded by the protocol and one batch avoids thousands of SQL round trips.
    let (mut buckets, mut labels, mut domains, mut ups, mut downs) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut totals = BTreeMap::<(i64, String, String, String), (i64, i64)>::new();
    // A restarted/misbehaving node cannot evade the per-hour storage budget by
    // rotating its volatile epoch or splitting a snapshot into many requests.
    let persisted=sqlx::query(&kind.sql("SELECT bucket,tenant_id,user_id,domain FROM user_other_domain_hourly WHERE node_id=$1 AND bucket >= $2"))
        .bind(node).bind(report.read_at_unix_secs/3600*3600-3600).fetch_all(&mut *tx).await?;
    let mut persisted_keys: BTreeSet<_> = persisted
        .into_iter()
        .map(|r| {
            (
                r.get::<i64, _>("bucket"),
                r.get::<String, _>("tenant_id"),
                r.get::<String, _>("user_id"),
                r.get::<String, _>(kind.key_column()),
            )
        })
        .collect();
    let mut bucket_counts = BTreeMap::<i64, usize>::new();
    for (bucket, _, _, _) in &persisted_keys {
        *bucket_counts.entry(*bucket).or_default() += 1;
    }
    for r in &report.counters {
        let Some((tenant, user)) = owners.get(&r.label) else {
            limited = true;
            continue;
        };
        let (old_up, old_down) = old
            .get(&(r.bucket, r.label.clone(), r.domain.clone()))
            .copied()
            .unwrap_or_default();
        let (up, down) = (r.uplink_bytes as i64, r.downlink_bytes as i64);
        if up < old_up || down < old_down {
            limited = true;
            continue;
        }
        if up == old_up && down == old_down {
            continue;
        }
        let key = (r.bucket, tenant.clone(), user.clone(), r.domain.clone());
        if !persisted_keys.contains(&key) {
            let count = bucket_counts.entry(r.bucket).or_default();
            if *count >= policy.node_capacity as usize {
                limited = true;
                continue;
            }
            *count += 1;
            persisted_keys.insert(key.clone());
        }
        let t = totals.entry(key).or_default();
        t.0 =
            t.0.checked_add(up - old_up)
                .ok_or_else(|| StoreError::InvalidData("domain aggregation overflow".into()))?;
        t.1 =
            t.1.checked_add(down - old_down)
                .ok_or_else(|| StoreError::InvalidData("domain aggregation overflow".into()))?;
        buckets.push(r.bucket);
        labels.push(r.label.as_str());
        domains.push(r.domain.as_str());
        ups.push(up);
        downs.push(down);
    }
    if !buckets.is_empty() {
        sqlx::query(&kind.sql("INSERT INTO other_domain_counter_heads (node_id,epoch,bucket,label,domain,uplink_bytes,downlink_bytes) SELECT $1,$2,x.* FROM unnest($3::bigint[],$4::text[],$5::text[],$6::bigint[],$7::bigint[]) x(bucket,label,domain,up,down) ON CONFLICT (node_id,epoch,bucket,label,domain) DO UPDATE SET uplink_bytes=EXCLUDED.uplink_bytes,downlink_bytes=EXCLUDED.downlink_bytes"))
            .bind(node).bind(&report.epoch).bind(&buckets).bind(&labels).bind(&domains).bind(&ups).bind(&downs).execute(&mut *tx).await?;
    }
    if !totals.is_empty() {
        let (mut bs, mut ts, mut us, mut ds, mut up, mut down) = (
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
        );
        for ((b, t, u, d), (a, z)) in &totals {
            bs.push(*b);
            ts.push(t.as_str());
            us.push(u.as_str());
            ds.push(d.as_str());
            up.push(*a);
            down.push(*z);
        }
        sqlx::query(&kind.sql("INSERT INTO user_other_domain_hourly (bucket,node_id,tenant_id,user_id,domain,uplink_bytes,downlink_bytes) SELECT x.bucket,$1,x.tenant,x.user_id,x.domain,x.up,x.down FROM unnest($2::bigint[],$3::text[],$4::text[],$5::text[],$6::bigint[],$7::bigint[]) x(bucket,tenant,user_id,domain,up,down) ON CONFLICT (bucket,node_id,tenant_id,user_id,domain) DO UPDATE SET uplink_bytes=user_other_domain_hourly.uplink_bytes+EXCLUDED.uplink_bytes,downlink_bytes=user_other_domain_hourly.downlink_bytes+EXCLUDED.downlink_bytes"))
            .bind(node).bind(&bs).bind(&ts).bind(&us).bind(&ds).bind(&up).bind(&down).execute(&mut *tx).await?;
    }
    sqlx::query(&kind.sql("INSERT INTO node_other_domain_state (node_id,epoch,read_at,observed_since,limited) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (node_id) DO UPDATE SET epoch=EXCLUDED.epoch,read_at=EXCLUDED.read_at,observed_since=EXCLUDED.observed_since,limited=EXCLUDED.limited"))
        .bind(node).bind(&report.epoch).bind(report.read_at_unix_secs).bind(since).bind(limited).execute(&mut *tx).await?;
    // Trim only this node's heads, independently of the fleet's daily housekeeping clock.
    sqlx::query(&kind.sql(
        "DELETE FROM other_domain_counter_heads WHERE node_id=$1 AND (epoch<>$2 OR bucket < $3)",
    ))
    .bind(node)
    .bind(&report.epoch)
    .bind(report.read_at_unix_secs / 3600 * 3600 - 3600)
    .execute(&mut *tx)
    .await?;
    sqlx::query(&kind.sql("DELETE FROM user_other_domain_hourly WHERE ctid IN (SELECT ctid FROM user_other_domain_hourly WHERE node_id=$1 AND bucket < $2 ORDER BY bucket LIMIT 1024)"))
        .bind(node).bind((now/3600-23)*3600).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn query(
    pool: &PgPool,
    actor: &AdminContext,
    tenant: &str,
    user: &str,
    period: SiteUsagePeriod,
) -> Result<UserOtherDomains> {
    query_for(
        pool,
        actor,
        DetailScope::User { tenant, user },
        period,
        DetailKind::Domain,
    )
    .await
}

pub(crate) async fn query_node(
    pool: &PgPool,
    actor: &AdminContext,
    node: &str,
    period: SiteUsagePeriod,
) -> Result<UserOtherDomains> {
    query_for(
        pool,
        actor,
        DetailScope::Node(node),
        period,
        DetailKind::Domain,
    )
    .await
}

/// Whose detail rows a query reads.
#[derive(Clone, Copy)]
enum DetailScope<'a> {
    /// One user on every ingress machine that carries the user.
    User { tenant: &'a str, user: &'a str },
    /// Every user in the actor's tenant scope on one ingress machine.
    Node(&'a str),
}

async fn query_for(
    pool: &PgPool,
    actor: &AdminContext,
    scope: DetailScope<'_>,
    period: SiteUsagePeriod,
    kind: DetailKind,
) -> Result<UserOtherDomains> {
    let nodes: Vec<_> = match scope {
        DetailScope::User { tenant, user } => {
            crate::usage::user_realtime_targets(pool, actor, tenant, user)
                .await?
                .into_iter()
                .filter(|t| !t.labels.is_empty())
                .map(|t| t.node_id)
                .collect()
        }
        DetailScope::Node(node) => crate::site_usage::classified_node(pool, actor, node).await?,
    };
    let bounds = crate::site_usage::period_bounds(pool, period).await?;
    let now = bounds.now;
    // Detail hours are kept for 24 hours (prune_for); a longer period starts at the oldest kept
    // hour and the returned range start says so.
    let start = bounds.start.max((now / 3600 - 23) * 3600);
    let policy = policy_for(pool, kind).await?;
    let state=sqlx::query(&kind.sql("SELECT count(*) FILTER (WHERE read_at >= $2)::bigint AS reporting,bool_or(limited) AS limited,max(observed_since) AS since,max(read_at) AS latest FROM node_other_domain_state WHERE node_id=ANY($1)")).bind(&nodes).bind(now-600).fetch_one(pool).await?;
    let rows = match scope {
        DetailScope::User { tenant, user } => sqlx::query(&kind.sql("SELECT domain,sum(uplink_bytes)::bigint AS up,sum(downlink_bytes)::bigint AS down FROM user_other_domain_hourly WHERE tenant_id=$1 AND user_id=$2 AND bucket >= $3 AND bucket <= $4 GROUP BY domain ORDER BY sum(uplink_bytes::numeric+downlink_bytes::numeric) DESC,domain LIMIT $5"))
            .bind(tenant).bind(user).bind(start).bind(now).bind(i64::from(policy.top_n)).fetch_all(pool).await?,
        DetailScope::Node(node) => sqlx::query(&kind.sql("SELECT domain,sum(uplink_bytes)::bigint AS up,sum(downlink_bytes)::bigint AS down FROM user_other_domain_hourly WHERE node_id=$1 AND bucket >= $2 AND bucket <= $3 AND ($5::text IS NULL OR tenant_id=$5 OR tenant_id LIKE $6 ESCAPE '\\') GROUP BY domain ORDER BY sum(uplink_bytes::numeric+downlink_bytes::numeric) DESC,domain LIMIT $4"))
            .bind(node).bind(start).bind(now).bind(i64::from(policy.top_n)).bind(actor.tenant_scope()).bind(actor.tenant_scope_like_pattern()).fetch_all(pool).await?,
    };
    Ok(UserOtherDomains {
        collection_enabled: policy.enabled,
        top_n: policy.top_n,
        range_start_unix_secs: start,
        range_end_unix_secs: now,
        reporting_nodes: state.get::<i64, _>("reporting") as u64,
        expected_nodes: nodes.len() as u64,
        limited: state.get::<Option<bool>, _>("limited").unwrap_or(false),
        observed_since_unix_secs: state.get("since"),
        latest_report_unix_secs: state.get("latest"),
        rows: rows
            .into_iter()
            .map(|r| UserOtherDomainRow {
                domain: r.get(kind.key_column()),
                uplink_bytes: r.get::<i64, _>("up") as u64,
                downlink_bytes: r.get::<i64, _>("down") as u64,
            })
            .collect(),
    })
}
pub(crate) async fn prune(pool: &PgPool) -> Result<()> {
    prune_hours(pool, 24, 24, 2, 2).await
}

pub(crate) async fn prune_hours(
    pool: &PgPool,
    domain_history_hours: u32,
    failed_history_hours: u32,
    domain_head_hours: u32,
    failed_head_hours: u32,
) -> Result<()> {
    prune_for_hours(
        pool,
        DetailKind::Domain,
        domain_history_hours,
        domain_head_hours,
    )
    .await?;
    prune_for_hours(
        pool,
        DetailKind::FailedTarget,
        failed_history_hours,
        failed_head_hours,
    )
    .await?;
    Ok(())
}

async fn prune_for_hours(
    pool: &PgPool,
    kind: DetailKind,
    history_hours: u32,
    head_hours: u32,
) -> Result<()> {
    let history_cutoff = i64::from(history_hours.clamp(1, crate::MAX_RETENTION_HOURS)) * 3_600;
    let head_cutoff = i64::from(head_hours.clamp(1, crate::MAX_RETENTION_HOURS)) * 3_600;
    for (sql, cutoff) in [
        (
            "DELETE FROM user_other_domain_hourly WHERE ctid IN (SELECT ctid FROM user_other_domain_hourly WHERE bucket < extract(epoch FROM now())::bigint-$1 ORDER BY bucket LIMIT 10000)",
            history_cutoff,
        ),
        (
            "DELETE FROM other_domain_counter_heads WHERE ctid IN (SELECT ctid FROM other_domain_counter_heads WHERE bucket < extract(epoch FROM now())::bigint-$1 ORDER BY bucket LIMIT 10000)",
            head_cutoff,
        ),
    ] {
        for _ in 0..64 {
            if sqlx::query(&kind.sql(sql))
                .bind(cutoff)
                .execute(pool)
                .await?
                .rows_affected()
                < 10_000
            {
                break;
            }
        }
    }
    Ok(())
}

pub(crate) async fn failed_policy(pool: &PgPool) -> Result<SniffingFailedPolicy> {
    Ok(SniffingFailedPolicy::from_budget(
        policy_for(pool, DetailKind::FailedTarget).await?,
    ))
}
pub(crate) async fn update_failed_policy(
    pool: &PgPool,
    actor: &AdminContext,
    value: SniffingFailedPolicy,
) -> Result<SniffingFailedPolicy> {
    Ok(SniffingFailedPolicy::from_budget(
        update_policy_for(pool, actor, value.budget(), DetailKind::FailedTarget).await?,
    ))
}
pub(crate) async fn record_failed(
    pool: &PgPool,
    node: &str,
    report: SniffingFailedReport,
) -> Result<()> {
    record_for(
        pool,
        node,
        report.map_counters(|r| brocade_deployment::other_domain::OtherDomainCounter {
            bucket: r.bucket,
            label: r.label,
            domain: r.target,
            uplink_bytes: r.uplink_bytes,
            downlink_bytes: r.downlink_bytes,
        }),
        DetailKind::FailedTarget,
    )
    .await
}
pub(crate) async fn query_failed(
    pool: &PgPool,
    actor: &AdminContext,
    tenant: &str,
    user: &str,
    period: SiteUsagePeriod,
) -> Result<UserSniffingFailedTargets> {
    failed_targets(pool, actor, DetailScope::User { tenant, user }, period).await
}

pub(crate) async fn query_failed_node(
    pool: &PgPool,
    actor: &AdminContext,
    node: &str,
    period: SiteUsagePeriod,
) -> Result<UserSniffingFailedTargets> {
    failed_targets(pool, actor, DetailScope::Node(node), period).await
}

async fn failed_targets(
    pool: &PgPool,
    actor: &AdminContext,
    scope: DetailScope<'_>,
    period: SiteUsagePeriod,
) -> Result<UserSniffingFailedTargets> {
    Ok(
        query_for(pool, actor, scope, period, DetailKind::FailedTarget)
            .await?
            .map_rows(|r| UserSniffingFailedRow {
                target: r.domain,
                uplink_bytes: r.uplink_bytes,
                downlink_bytes: r.downlink_bytes,
            }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_over_budget_and_sensitive_destinations() {
        let mut report = OtherDomainReport {
            version: 1,
            epoch: "0123456789abcdef0123456789abcdef".into(),
            activation_unix_secs: 7201,
            read_at_unix_secs: 7300,
            usage_generation_id: 1,
            limited: false,
            counters: vec![],
        };
        assert!(validate(&report, 7300).is_ok());
        report
            .counters
            .push(brocade_deployment::other_domain::OtherDomainCounter {
                bucket: 7200,
                label: "a@t#i".into(),
                domain: "https://secret.example/path".into(),
                uplink_bytes: 1,
                downlink_bytes: 0,
            });
        assert!(validate(&report, 7300).is_err());
    }
}
