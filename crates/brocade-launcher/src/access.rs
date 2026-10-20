use crate::optional_env;
use anyhow::{bail, Context, Result};
use clap::Args;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};

pub(crate) const DEFAULT_PORT: u16 = 8080;

#[derive(Clone, Debug, Default, Args)]
pub(crate) struct AccessArgs {
    /// 其他机器访问本机的 IP；默认使用默认路由的本机地址
    #[arg(long, value_name = "IP")]
    pub(crate) public_ip: Option<IpAddr>,
    /// HTTP 监听端口；默认 8080
    #[arg(long, value_name = "PORT", value_parser = clap::value_parser!(u16).range(1..), conflicts_with = "bind")]
    pub(crate) port: Option<u16>,
    /// 完整监听地址；默认 0.0.0.0:8080
    #[arg(long, value_name = "ADDR")]
    pub(crate) bind: Option<SocketAddr>,
}

pub(crate) struct Access {
    pub(crate) bind: SocketAddr,
    pub(crate) public_url: String,
}

impl AccessArgs {
    pub(crate) fn resolve(&self) -> Result<Access> {
        let configured_bind = if self.bind.is_none() && self.port.is_none() {
            optional_env("BROCADE_ADMIN_BIND")?
                .map(|value| {
                    value
                        .parse()
                        .context("BROCADE_ADMIN_BIND 不是合法的 IP:PORT")
                })
                .transpose()?
        } else {
            None
        };
        let default_ip = if self.public_ip.is_some_and(|ip| ip.is_ipv6()) {
            IpAddr::V6(Ipv6Addr::UNSPECIFIED)
        } else {
            IpAddr::V4(Ipv4Addr::UNSPECIFIED)
        };
        let bind = self.bind.unwrap_or_else(|| {
            if let Some(port) = self.port {
                SocketAddr::new(default_ip, port)
            } else {
                configured_bind.unwrap_or(SocketAddr::new(default_ip, DEFAULT_PORT))
            }
        });
        if bind.port() == 0 {
            bail!("HTTP 端口必须在 1 至 65535 之间");
        }
        let public_url = if let Some(ip) = self.public_ip {
            ip_url(ip, bind.port())?
        } else if let Some(url) = optional_env("BROCADE_AGENT_PUBLIC_URL")? {
            // Reuse the same origin validation as the initialization link, without a credential.
            let mut origin = reqwest::Url::parse(&crate::entry::entry_url(&url, None, false)?)?;
            if self.port.is_some() {
                origin
                    .set_port(Some(bind.port()))
                    .map_err(|()| anyhow::anyhow!("无法设置访问端口"))?;
            }
            origin.to_string().trim_end_matches('/').to_owned()
        } else {
            let ip = if bind.ip().is_unspecified() {
                default_route_ip()?
            } else {
                bind.ip()
            };
            ip_url(ip, bind.port())?
        };
        Ok(Access { bind, public_url })
    }
}

fn ip_url(ip: IpAddr, port: u16) -> Result<String> {
    if ip.is_unspecified() || ip.is_multicast() {
        bail!("访问 IP 不能是未指定地址或组播地址");
    }
    Ok(format!("http://{}", SocketAddr::new(ip, port)))
}

fn default_route_ip() -> Result<IpAddr> {
    // UDP connect asks the kernel for its route's source address without transmitting a packet.
    // NAT deployments can supply --public-ip; the installer displays this default for correction.
    for (local, destination) in [
        (SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)), "8.8.8.8:80"),
        (
            SocketAddr::from((Ipv6Addr::UNSPECIFIED, 0)),
            "[2001:4860:4860::8888]:80",
        ),
    ] {
        let Ok(socket) = UdpSocket::bind(local) else {
            continue;
        };
        if socket.connect(destination).is_ok() {
            let ip = socket.local_addr()?.ip();
            if !ip.is_unspecified() && !ip.is_loopback() {
                return Ok(ip);
            }
        }
    }
    bail!("无法自动识别服务器 IP；请通过 --public-ip IP 指定访问地址")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_port_and_ipv4_ipv6_origins_are_direct_http() {
        assert_eq!(DEFAULT_PORT, 8080);
        assert_eq!(
            ip_url("192.0.2.10".parse().unwrap(), DEFAULT_PORT).unwrap(),
            "http://192.0.2.10:8080"
        );
        assert_eq!(
            ip_url("2001:db8::10".parse().unwrap(), 9000).unwrap(),
            "http://[2001:db8::10]:9000"
        );
        assert!(ip_url("0.0.0.0".parse().unwrap(), DEFAULT_PORT).is_err());
        assert!(ip_url("::".parse().unwrap(), DEFAULT_PORT).is_err());
    }
}
