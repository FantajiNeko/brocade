use crate::{
    auth_state, download, optional_env, paths, reachable_loopback, validate_bootstrap_token,
};
use anyhow::{bail, Context, Result};
use clap::Args;
use std::{io::IsTerminal, net::SocketAddr, path::PathBuf};

#[derive(Debug, Args)]
pub(crate) struct UrlArgs {
    /// 等待受管 Tunnel 的公网地址，不回退到回环地址
    #[arg(long)]
    tunnel: bool,
    #[arg(long, value_name = "DIR")]
    data_dir: Option<PathBuf>,
    #[arg(long, value_name = "DIR")]
    cache_dir: Option<PathBuf>,
    #[arg(long, value_name = "ADDR")]
    bind: Option<SocketAddr>,
}

pub(crate) async fn print_current(args: UrlArgs) -> Result<()> {
    let paths = paths::LauncherPaths::resolve(args.data_dir, args.cache_dir)?;
    let local_url = format!(
        "http://{}",
        reachable_loopback(crate::admin_bind(args.bind)?)
    );
    let client = download::client()?;
    let initialized = auth_state(&client, &local_url).await?.initialized;
    let public_file = paths.runtime.join("public-url");
    let base = if args.tunnel {
        paths::read_private_text(&public_file).context("Tunnel 尚未就绪")?
    } else if let Some(url) = optional_env("BROCADE_AGENT_PUBLIC_URL")? {
        url
    } else if public_file.exists() {
        paths::read_private_text(&public_file)?
    } else {
        local_url
    };
    let token = if initialized {
        None
    } else {
        let token = match optional_env("BROCADE_BOOTSTRAP_TOKEN")? {
            Some(token) => token,
            None => paths::read_private_text(&paths.data.join("bootstrap-token"))?
                .trim()
                .to_owned(),
        };
        validate_bootstrap_token(&token)?;
        Some(token)
    };
    let terminal = std::io::stdout().is_terminal();
    let url = entry_url(base.trim(), token.as_deref(), terminal)?;
    println!(
        "{}：{url}",
        if initialized {
            "控制台地址"
        } else {
            "初始化地址"
        }
    );
    if token.is_some() && !terminal {
        eprintln!("一次性初始化链接仅在交互终端显示；请在终端运行 sudo brocade url");
    }
    Ok(())
}

/// Only a terminal may receive the capability; redirected stdout and service journals get the
/// ordinary URL. A fragment keeps the credential out of HTTP paths, queries and Referer headers.
pub(crate) fn entry_url(base: &str, token: Option<&str>, terminal: bool) -> Result<String> {
    let mut url = reqwest::Url::parse(base).context("控制台入口地址无效")?;
    let loopback = url
        .host_str()
        .and_then(|host| {
            host.trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .ok()
        })
        .is_some_and(|ip| ip.is_loopback());
    if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        bail!("控制台入口必须是 HTTPS 或回环 HTTP 地址，且不能包含账号信息");
    }
    url.set_fragment(None);
    if let Some(token) = token.filter(|_| terminal) {
        validate_bootstrap_token(token)?;
        let mut encoded = reqwest::Url::parse("https://bootstrap.invalid/")?;
        encoded
            .path_segments_mut()
            .expect("fixed HTTPS base has path segments")
            .push(token);
        url.set_fragment(Some(&format!("/initialize/{}", &encoded.path()[1..])));
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    const TOKEN: &str = "bootstrap-test-token-with-at-least-32-bytes";

    #[test]
    fn terminal_entry_carries_only_a_fragment_capability() {
        let result = entry_url(
            "https://console.example/base?from=install",
            Some(TOKEN),
            true,
        )
        .unwrap();
        let url = reqwest::Url::parse(&result).unwrap();
        assert_eq!(url.path(), "/base");
        assert_eq!(url.query(), Some("from=install"));
        assert_eq!(
            url.fragment(),
            Some(format!("/initialize/{TOKEN}").as_str())
        );
    }

    #[test]
    fn redirected_output_never_contains_a_credential() {
        for terminal in [false, true] {
            let plain = entry_url("https://console.example", None, terminal).unwrap();
            assert!(!plain.contains(TOKEN));
            assert!(reqwest::Url::parse(&plain).unwrap().fragment().is_none());
        }
        let logged = entry_url("https://console.example", Some(TOKEN), false).unwrap();
        assert!(!logged.contains(TOKEN));
        assert!(reqwest::Url::parse(&logged).unwrap().fragment().is_none());
    }

    #[test]
    fn capability_encodes_delimiters_and_refuses_cleartext_public_origins() {
        let token = format!("{TOKEN}/?#&= +%");
        let result = entry_url("http://127.0.0.1:8080", Some(&token), true).unwrap();
        let url = reqwest::Url::parse(&result).unwrap();
        assert_eq!(url.path(), "/");
        assert!(url.query().is_none());
        assert!(url.fragment().unwrap().contains("%2F"));
        for base in [
            "http://public.example",
            "https://user:pass@console.example",
            "file:///tmp/entry",
        ] {
            let error = entry_url(base, Some(TOKEN), true).unwrap_err().to_string();
            assert!(!error.contains(TOKEN));
        }
    }
}
