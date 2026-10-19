//! A single TCP connect from the forwarding machine to a saved rule's target.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TcpPingStatus {
    Reachable,
    Failed,
    NotRun,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TcpPingCode {
    Connected,
    InvalidTarget,
    DnsFailed,
    DnsBusy,
    DnsEmpty,
    AddressBlocked,
    ConnectFailed,
    Timeout,
    AgentUpgradeRequired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TcpPingResult {
    pub status: TcpPingStatus,
    pub code: TcpPingCode,
    pub dns_ms: Option<u32>,
    /// TCP handshake only. DNS and control-plane queue time are excluded.
    pub connect_ms: Option<u32>,
    pub resolved_ip: Option<String>,
}

impl TcpPingResult {
    pub fn not_run(code: TcpPingCode) -> Self {
        Self {
            status: TcpPingStatus::NotRun,
            code,
            dns_ms: None,
            connect_ms: None,
            resolved_ip: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForwardingProbeTarget {
    pub probe_id: String,
    pub rule_id: i64,
    pub target_host: String,
    pub target_port: u16,
    pub allow_private_targets: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForwardingProbeReport {
    pub probe_id: String,
    pub result: TcpPingResult,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tcp_ping_wire_result_distinguishes_not_run_from_failure() {
        let result = TcpPingResult::not_run(TcpPingCode::AgentUpgradeRequired);
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["status"], "not_run");
        assert_eq!(json["code"], "agent-upgrade-required");
        assert_eq!(
            serde_json::from_value::<TcpPingResult>(json).unwrap(),
            result
        );
    }
}
