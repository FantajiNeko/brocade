//! Versioned observation categories shared with the embedded Xray. Raw domains are never
//! transmitted by the Agent or returned to the browser.
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

pub const SITE_USAGE_VERSION: u32 = 1;
pub const MAX_SITE_USAGE_COUNTERS: usize = 8192;
pub const SITE_USAGE_ENABLED_HEADER: &str = "x-brocade-site-usage-enabled";

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct SiteUsagePolicy {
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiteDefinition {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing)]
    pub domains: Vec<String>,
}

pub fn catalog() -> &'static [SiteDefinition] {
    #[derive(Deserialize)]
    struct Catalog {
        version: u32,
        sites: Vec<SiteDefinition>,
    }
    static CATALOG: OnceLock<Vec<SiteDefinition>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let value: Catalog = serde_json::from_str(include_str!(
            "../../../components/xray-core/common/siteusage/catalog.json"
        ))
        .expect("embedded site usage catalog must be valid JSON");
        assert_eq!(
            value.version, SITE_USAGE_VERSION,
            "site catalog version must match the wire contract"
        );
        value.sites
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SiteUsageCounter {
    pub label: String,
    pub site_id: String,
    pub uplink_bytes: u64,
    pub downlink_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SiteUsageReport {
    pub version: u32,
    /// Independent persistent journal identity; site observations cannot exhaust billing slots.
    pub epoch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activation_id: Option<i64>,
    pub limited: bool,
    pub counters: Vec<SiteUsageCounter>,
}

/// Calendar period of a user's site report. Boundaries are calendar days, ISO weeks (Monday) and
/// months at +08, the same zone as monthly usage and quotas.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SiteUsagePeriod {
    #[default]
    Day,
    Week,
    Month,
}

impl SiteUsagePeriod {
    /// PostgreSQL `date_trunc` field and interval unit for the period.
    pub fn calendar_unit(self) -> &'static str {
        match self {
            Self::Day => "day",
            Self::Week => "week",
            Self::Month => "month",
        }
    }

    /// Width of one series bucket: stored UTC hours for a day or a week, +08 calendar days for a
    /// month. +08 is a whole-hour offset, so both widths start on stored hour boundaries.
    pub fn bucket_secs(self) -> u32 {
        match self {
            Self::Day | Self::Week => 3_600,
            Self::Month => 86_400,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSiteUsageRow {
    pub site_id: String,
    pub name: String,
    pub uplink_bytes: u64,
    pub downlink_bytes: u64,
}

/// Traffic of one category over time. Each point is `[bucket start, uplink, downlink]`; buckets
/// without traffic are omitted, so an absent bucket inside the observed range means zero.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSiteUsageSeries {
    pub site_id: String,
    pub points: Vec<(i64, u64, u64)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSiteUsage {
    pub collection_enabled: bool,
    pub catalog_version: u32,
    pub period: SiteUsagePeriod,
    /// Start of the calendar period; totals and series cover `[range_start, range_end]`.
    pub range_start_unix_secs: i64,
    /// The query time, inside the period.
    pub range_end_unix_secs: i64,
    /// End of the calendar period, so a chart can lay out the hours or days still to come.
    pub period_end_unix_secs: i64,
    pub bucket_secs: u32,
    pub reporting_nodes: u64,
    pub expected_nodes: u64,
    pub limited: bool,
    pub latest_report_unix_secs: Option<i64>,
    pub observed_since_unix_secs: Option<i64>,
    pub rows: Vec<UserSiteUsageRow>,
    pub series: Vec<UserSiteUsageSeries>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_is_unique_bounded_and_contains_failure_categories() {
        let sites = catalog();
        let ids: std::collections::BTreeSet<_> = sites.iter().map(|site| &site.id).collect();
        assert_eq!(ids.len(), sites.len());
        assert!(sites.len() <= 64);
        for id in ["other", "sniffing-failed", "unidentified"] {
            assert!(sites.iter().any(|site| site.id == id));
        }
        assert!(sites.iter().all(|site| site
            .id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'-')));
    }

    #[test]
    fn period_query_values_are_lowercase_and_default_to_day() {
        assert_eq!(SiteUsagePeriod::default(), SiteUsagePeriod::Day);
        for (period, text) in [
            (SiteUsagePeriod::Day, "day"),
            (SiteUsagePeriod::Week, "week"),
            (SiteUsagePeriod::Month, "month"),
        ] {
            assert_eq!(serde_json::to_value(period).unwrap(), text);
            assert_eq!(
                serde_json::from_value::<SiteUsagePeriod>(text.into()).unwrap(),
                period
            );
            assert_eq!(period.calendar_unit(), text);
        }
        assert!(serde_json::from_value::<SiteUsagePeriod>("year".into()).is_err());
        assert_eq!(SiteUsagePeriod::Week.bucket_secs(), 3_600);
        assert_eq!(SiteUsagePeriod::Month.bucket_secs(), 86_400);
    }
}
