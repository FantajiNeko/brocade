//! Bounded source-IP observations. These are diagnostic bytes, never a second billing ledger.
use serde::{Deserialize, Serialize};

pub const SOURCE_TRAFFIC_HEADER: &str = "x-brocade-source-traffic";
pub const SOURCE_TRAFFIC_BUCKET_SECS: i64 = 30;
pub const SOURCE_TRAFFIC_MAX_ROWS: usize = 8192;

pub fn valid_source_ip(value: &str) -> bool {
    value
        .parse::<std::net::IpAddr>()
        .is_ok_and(|ip| !ip.is_unspecified() && !ip.is_multicast() && ip.to_string() == value)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceTrafficCounter {
    pub bucket: i64,
    pub label: String,
    pub source_ip: String,
    pub uplink_bytes: u64,
    pub downlink_bytes: u64,
}

pub type SourceTrafficReport = crate::other_domain::DetailUsageReport<SourceTrafficCounter>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrafficTimeRange {
    pub start_unix_secs: i64,
    pub end_unix_secs: i64,
}

impl TrafficTimeRange {
    pub fn validate(self, now: i64) -> Result<Self, &'static str> {
        if self.start_unix_secs <= 0
            || self.end_unix_secs <= self.start_unix_secs
            || self.end_unix_secs > now + 60
            || self.end_unix_secs - self.start_unix_secs > 31 * 86400
            || self.start_unix_secs % SOURCE_TRAFFIC_BUCKET_SECS != 0
            || self.end_unix_secs % SOURCE_TRAFFIC_BUCKET_SECS != 0
        {
            return Err("traffic range requires ordered 30-second boundaries within 31 days and no future end");
        }
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_and_time_boundaries_are_canonical() {
        for ip in ["192.0.2.1", "2001:db8::1"] {
            assert!(valid_source_ip(ip));
        }
        for ip in [
            "0.0.0.0",
            "224.0.0.1",
            "fe80::1%eth0",
            "2001:DB8::1",
            "a.example",
        ] {
            assert!(!valid_source_ip(ip));
        }
        let valid = TrafficTimeRange {
            start_unix_secs: 1_800_000_000,
            end_unix_secs: 1_800_000_120,
        };
        assert!(valid.validate(valid.end_unix_secs).is_ok());
        assert!(TrafficTimeRange {
            end_unix_secs: valid.start_unix_secs,
            ..valid
        }
        .validate(valid.end_unix_secs)
        .is_err());
        assert!(TrafficTimeRange {
            start_unix_secs: valid.start_unix_secs + 1,
            ..valid
        }
        .validate(valid.end_unix_secs)
        .is_err());
    }
}
