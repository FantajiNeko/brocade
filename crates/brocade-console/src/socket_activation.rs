//! HTTP listener setup, including systemd socket activation.
//!
//! Keeping the listening socket in PID 1 lets a normal Console restart finish the requests held
//! by the old process while new TCP handshakes wait in the kernel backlog for the replacement.
//! The configured addresses remain authoritative: an inherited descriptor is accepted only when
//! it is a listening TCP socket bound to one of those exact addresses.

use std::{
    env, io,
    net::{SocketAddr, TcpListener as StdTcpListener},
};

#[derive(Debug)]
pub struct HttpListeners {
    pub admin: tokio::net::TcpListener,
    pub agent: Option<tokio::net::TcpListener>,
    pub socket_activated: bool,
}

pub async fn open(
    admin_bind: SocketAddr,
    agent_bind: Option<SocketAddr>,
) -> io::Result<HttpListeners> {
    #[cfg(unix)]
    if let Some(listeners) = unix::inherited_listeners()? {
        return from_inherited(admin_bind, agent_bind, listeners);
    }

    Ok(HttpListeners {
        admin: tokio::net::TcpListener::bind(admin_bind).await?,
        agent: match agent_bind {
            Some(bind) => Some(tokio::net::TcpListener::bind(bind).await?),
            None => None,
        },
        socket_activated: false,
    })
}

fn from_inherited(
    admin_bind: SocketAddr,
    agent_bind: Option<SocketAddr>,
    listeners: Vec<StdTcpListener>,
) -> io::Result<HttpListeners> {
    let expected = usize::from(agent_bind.is_some()) + 1;
    if listeners.len() != expected {
        return Err(invalid(format!(
            "systemd passed {} listener(s), but BROCADE_ADMIN_BIND/BROCADE_AGENT_BIND require {expected}",
            listeners.len()
        )));
    }

    let mut admin = None;
    let mut agent = None;
    for listener in listeners {
        let actual = listener.local_addr()?;
        let destination = if actual == admin_bind {
            &mut admin
        } else if agent_bind == Some(actual) {
            &mut agent
        } else {
            return Err(invalid(format!(
                "systemd listener {actual} does not match BROCADE_ADMIN_BIND={admin_bind}{}",
                agent_bind
                    .map(|bind| format!(" or BROCADE_AGENT_BIND={bind}"))
                    .unwrap_or_default()
            )));
        };
        if destination.is_some() {
            return Err(invalid(format!(
                "systemd passed more than one listener for {actual}"
            )));
        }
        listener.set_nonblocking(true)?;
        *destination = Some(tokio::net::TcpListener::from_std(listener)?);
    }

    Ok(HttpListeners {
        admin: admin.ok_or_else(|| {
            invalid(format!(
                "systemd did not pass the BROCADE_ADMIN_BIND listener {admin_bind}"
            ))
        })?,
        agent: match agent_bind {
            Some(bind) => Some(agent.ok_or_else(|| {
                invalid(format!(
                    "systemd did not pass the BROCADE_AGENT_BIND listener {bind}"
                ))
            })?),
            None => None,
        },
        socket_activated: true,
    })
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

#[cfg(unix)]
mod unix {
    use std::{
        ffi::OsString,
        os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
    };

    use super::*;

    const SD_LISTEN_FDS_START: RawFd = 3;

    pub(super) fn inherited_listeners() -> io::Result<Option<Vec<StdTcpListener>>> {
        let listen_pid = env::var_os("LISTEN_PID");
        let listen_fds = env::var_os("LISTEN_FDS");
        if listen_pid.is_none() && listen_fds.is_none() {
            return Ok(None);
        }
        let listen_pid = parse_env_u32("LISTEN_PID", listen_pid)?;
        let listen_fds = parse_env_u32("LISTEN_FDS", listen_fds)?;
        if listen_pid != std::process::id() {
            // Activation variables inherited by a child are not meant for that child. This is the
            // same PID guard used by sd_listen_fds(3).
            return Ok(None);
        }
        if listen_fds == 0 {
            return Ok(None);
        }
        if listen_fds > 2 {
            return Err(invalid(format!(
                "systemd passed {listen_fds} descriptors; Brocade accepts at most admin and agent"
            )));
        }

        let mut listeners = Vec::with_capacity(listen_fds as usize);
        for offset in 0..listen_fds {
            let raw = SD_LISTEN_FDS_START + offset as RawFd;
            validate_listening_tcp_socket(raw)?;
            // SAFETY: systemd owns descriptors 3..3+LISTEN_FDS for this process and transfers that
            // ownership to the service. Each descriptor is consumed exactly once in this loop.
            let fd = unsafe { OwnedFd::from_raw_fd(raw) };
            set_close_on_exec(&fd)?;
            listeners.push(StdTcpListener::from(fd));
        }
        Ok(Some(listeners))
    }

    fn parse_env_u32(name: &str, value: Option<OsString>) -> io::Result<u32> {
        let value = value.ok_or_else(|| invalid(format!("{name} is missing")))?;
        let value = value
            .to_str()
            .ok_or_else(|| invalid(format!("{name} is not valid UTF-8")))?;
        value
            .parse()
            .map_err(|_| invalid(format!("{name} is not an unsigned integer")))
    }

    fn validate_listening_tcp_socket(fd: RawFd) -> io::Result<()> {
        let socket_type = socket_option(fd, libc::SO_TYPE)?;
        if socket_type != libc::SOCK_STREAM {
            return Err(invalid(format!(
                "systemd descriptor {fd} is not a TCP stream socket"
            )));
        }
        if socket_option(fd, libc::SO_ACCEPTCONN)? != 1 {
            return Err(invalid(format!("systemd descriptor {fd} is not listening")));
        }
        Ok(())
    }

    fn socket_option(fd: RawFd, option: libc::c_int) -> io::Result<libc::c_int> {
        let mut value = 0;
        let mut length = std::mem::size_of_val(&value) as libc::socklen_t;
        // SAFETY: `value` and `length` point to correctly sized writable storage for an integer
        // SOL_SOCKET option; `fd` remains open throughout the call.
        let result = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                option,
                (&mut value as *mut libc::c_int).cast(),
                &mut length,
            )
        };
        if result == -1 {
            Err(io::Error::last_os_error())
        } else {
            Ok(value)
        }
    }

    fn set_close_on_exec(fd: &OwnedFd) -> io::Result<()> {
        // SAFETY: fcntl does not retain the descriptor and both commands use their documented
        // integer argument shapes.
        let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFD) };
        if flags == -1 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, flags | libc::FD_CLOEXEC) } == -1 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn std_listener() -> StdTcpListener {
        StdTcpListener::bind("127.0.0.1:0").unwrap()
    }

    #[tokio::test]
    async fn one_inherited_listener_serves_the_merged_surface() {
        let listener = std_listener();
        let bind = listener.local_addr().unwrap();
        let opened = from_inherited(bind, None, vec![listener]).unwrap();
        assert!(opened.socket_activated);
        assert_eq!(opened.admin.local_addr().unwrap(), bind);
        assert!(opened.agent.is_none());
    }

    #[tokio::test]
    async fn split_listeners_are_matched_by_address_not_descriptor_order() {
        let admin = std_listener();
        let agent = std_listener();
        let admin_bind = admin.local_addr().unwrap();
        let agent_bind = agent.local_addr().unwrap();
        let opened = from_inherited(admin_bind, Some(agent_bind), vec![agent, admin]).unwrap();
        assert_eq!(opened.admin.local_addr().unwrap(), admin_bind);
        assert_eq!(opened.agent.unwrap().local_addr().unwrap(), agent_bind);
    }

    #[tokio::test]
    async fn an_unconfigured_inherited_address_is_rejected() {
        let configured = std_listener();
        let configured_bind = configured.local_addr().unwrap();
        drop(configured);
        let inherited = std_listener();
        let error = from_inherited(configured_bind, None, vec![inherited]).unwrap_err();
        assert!(error.to_string().contains("does not match"));
    }
}
