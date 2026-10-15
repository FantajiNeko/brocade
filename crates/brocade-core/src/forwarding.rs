//! Address policy shared by forwarding admission and the generated data-plane guard.

use std::{net::IpAddr, sync::LazyLock};

use ipnet::IpNet;

/// Literal ranges keep forwarding isolation independent of downloaded GeoIP databases.
pub const BLOCKED_TARGET_CIDRS: &[&str] = &[
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.88.99.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/3",
    "::/127",
    "2001:db8::/32",
    "fc00::/7",
    "fe80::/10",
    "ff00::/8",
];

/// Normalizes IPv4-mapped IPv6 before applying the same policy Xray receives.
pub fn target_ip_is_blocked(address: IpAddr) -> bool {
    static NETWORKS: LazyLock<Vec<IpNet>> = LazyLock::new(|| {
        BLOCKED_TARGET_CIDRS
            .iter()
            .map(|cidr| {
                cidr.parse()
                    .expect("forwarding CIDRs are valid literal networks")
            })
            .collect()
    });
    let address = address.to_canonical();
    NETWORKS.iter().any(|network| network.contains(&address))
}

#[cfg(test)]
mod tests {
    use super::target_ip_is_blocked;

    #[test]
    fn forwarding_blocks_special_and_mapped_targets() {
        for address in [
            "0.1.2.3",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.0.0.1",
            "192.168.1.1",
            "198.18.0.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
        ] {
            assert!(target_ip_is_blocked(address.parse().unwrap()), "{address}");
        }
        for address in ["1.1.1.1", "2606:4700:4700::1111", "::ffff:1.1.1.1"] {
            assert!(!target_ip_is_blocked(address.parse().unwrap()), "{address}");
        }
    }
}
