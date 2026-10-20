//! Optional failed-sniff observations contain original IP endpoints, never proxy next hops.
use crate::other_domain::{DetailUsageReport, OtherDomainPolicy, UserDetailUsage};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;

pub const SNIFFING_FAILED_POLICY_HEADER: &str = "x-brocade-sniffing-failed-policy";
pub const SNIFFING_FAILED_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SniffingFailedPolicy {
    pub enabled: bool,
    pub top_n: u32,
    pub max_targets_per_user: u32,
    pub node_capacity: u32,
    pub report_interval_secs: u32,
}
impl Default for SniffingFailedPolicy {
    fn default() -> Self {
        Self::from_budget(OtherDomainPolicy::default())
    }
}
impl SniffingFailedPolicy {
    pub fn validate(&self) -> Result<(), &'static str> {
        self.budget().validate()
    }
    pub fn budget(self) -> OtherDomainPolicy {
        OtherDomainPolicy {
            enabled: self.enabled,
            top_n: self.top_n,
            max_domains_per_user: self.max_targets_per_user,
            node_capacity: self.node_capacity,
            report_interval_secs: self.report_interval_secs,
        }
    }
    pub fn from_budget(value: OtherDomainPolicy) -> Self {
        Self {
            enabled: value.enabled,
            top_n: value.top_n,
            max_targets_per_user: value.max_domains_per_user,
            node_capacity: value.node_capacity,
            report_interval_secs: value.report_interval_secs,
        }
    }
}

/// Canonical tcp://IP:port or udp://[IPv6]:port only. No domains, URLs or paths.
pub fn valid_target(value: &str) -> bool {
    let Some((network, endpoint)) = value.split_once("://") else {
        return false;
    };
    if !matches!(network, "tcp" | "udp") || value.len() > 80 {
        return false;
    }
    let Ok(address) = endpoint.parse::<SocketAddr>() else {
        return false;
    };
    address.port() != 0
        && address.ip() == address.ip().to_canonical()
        && address.to_string() == endpoint
        && !matches!(address, SocketAddr::V6(v6) if v6.scope_id() != 0 || v6.flowinfo() != 0)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SniffingFailedCounter {
    #[serde(default, skip_serializing_if = "crate::other_domain::is_zero")]
    pub counter_id: u64,
    pub bucket: i64,
    pub label: String,
    pub target: String,
    pub uplink_bytes: u64,
    pub downlink_bytes: u64,
}
pub type SniffingFailedReport = DetailUsageReport<SniffingFailedCounter>;
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSniffingFailedRow {
    pub target: String,
    pub uplink_bytes: u64,
    pub downlink_bytes: u64,
}
pub type UserSniffingFailedTargets = UserDetailUsage<UserSniffingFailedRow>;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_ip_transport_and_budget_boundaries() {
        assert!(!SniffingFailedPolicy::default().enabled);
        assert_eq!(SniffingFailedPolicy::default().top_n, 128);
        assert_eq!(SniffingFailedPolicy::default().max_targets_per_user, 1024);
        assert!(SniffingFailedPolicy::default().validate().is_ok());
        for value in ["tcp://192.0.2.1:443", "udp://[2001:db8::1]:53"] {
            assert!(valid_target(value), "{value}");
        }
        for value in [
            "tcp://example.com:443",
            "https://192.0.2.1:443",
            "tcp://192.0.2.1:0",
            "tcp://192.0.2.1:65536",
            "udp://[2001:0db8::1]:53",
            "tcp://[::ffff:192.0.2.1]:443",
            "tcp://[fe80::1%1]:443",
            "tcp://192.0.2.1:443/path",
            "tcp://192.0.2.1:443>>>x",
        ] {
            assert!(!valid_target(value), "{value}");
        }
    }
}
