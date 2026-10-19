use std::{
    ffi::OsString,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream, UdpSocket},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use brocade_deployment::hotswap::{hot_swap, HotSwapOperation, ENDPOINT_SWAP_SUFFIX};
use serde_json::{json, Value};

struct Echo {
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Echo {
    fn start(marker: u8) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let worker = thread::spawn(move || {
            let mut clients = Vec::new();
            while !stopped.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let stopped = stopped.clone();
                        clients.push(thread::spawn(move || {
                            // Poll for fixture shutdown without expiring an idle TCP flow:
                            // candidate preparation can take longer than a socket timeout.
                            stream
                                .set_read_timeout(Some(Duration::from_millis(100)))
                                .unwrap();
                            stream
                                .set_write_timeout(Some(Duration::from_secs(5)))
                                .unwrap();
                            let mut bytes = [0; 4];
                            let mut filled = 0;
                            while !stopped.load(Ordering::Acquire) {
                                match stream.read(&mut bytes[filled..]) {
                                    Ok(0) => break,
                                    Ok(count) => filled += count,
                                    Err(error)
                                        if matches!(
                                            error.kind(),
                                            std::io::ErrorKind::WouldBlock
                                                | std::io::ErrorKind::TimedOut
                                                | std::io::ErrorKind::Interrupted
                                        ) =>
                                    {
                                        continue
                                    }
                                    Err(_) => break,
                                }
                                if filled == bytes.len() {
                                    if stream
                                        .write_all(&[
                                            marker, bytes[0], bytes[1], bytes[2], bytes[3],
                                        ])
                                        .is_err()
                                    {
                                        break;
                                    }
                                    filled = 0;
                                }
                            }
                        }));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(error) => panic!("echo accept: {error}"),
                }
            }
            for client in clients {
                client.join().unwrap();
            }
        });
        Self {
            address,
            stop,
            worker: Some(worker),
        }
    }
}

impl Drop for Echo {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.worker.take().unwrap().join().unwrap();
    }
}

struct Fixture {
    root: PathBuf,
    environment: Vec<(&'static str, Option<OsString>)>,
    receiver: Option<Child>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = super::terminate_processes(
            &super::serving_xray_processes_in(&self.root),
            super::XRAY_TERM_GRACE,
            super::XRAY_KILL_GRACE,
        );
        if let Some(receiver) = &mut self.receiver {
            let _ = receiver.kill();
            let _ = receiver.wait();
        }
        for (name, value) in &self.environment {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

fn free_address() -> SocketAddr {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
}

fn connect(address: SocketAddr) -> TcpStream {
    let stream = TcpStream::connect_timeout(&address, Duration::from_secs(3)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream
}

#[track_caller]
fn exchange(stream: &mut TcpStream, marker: u8) {
    stream.write_all(b"ping").unwrap();
    let mut reply = [0; 5];
    stream.read_exact(&mut reply).unwrap();
    assert_eq!(reply, [marker, b'p', b'i', b'n', b'g']);
}

#[test]
fn temporary_endpoint_counters_keep_separate_baselines_and_one_hop_identity() {
    use std::collections::BTreeMap;
    let original = "out:app/chain>receiver".to_owned();
    let temporary = format!("{original}{ENDPOINT_SWAP_SUFFIX}");
    let previous = BTreeMap::from([(original.clone(), 100), (temporary.clone(), 40)]);
    let now = BTreeMap::from([(original.clone(), 125), (temporary.clone(), 60)]);
    let hops = crate::probe::hop_health_deltas(&now, &previous);
    assert_eq!(hops.len(), 1);
    assert_eq!(hops[0].chain_id, "app/chain");
    assert_eq!(hops[0].peer_node_id, "receiver");
    assert_eq!(hops[0].downlink_bytes, 45);
    // A recreated temporary counter must not subtract bytes from the canonical handler.
    let reset = BTreeMap::from([(original, 130), (temporary, 1)]);
    assert_eq!(
        crate::probe::hop_health_deltas(&reset, &now)[0].downlink_bytes,
        5
    );
}

#[test]
#[ignore = "requires BROCADE_TEST_XRAY and IPv6 loopback; run serially"]
fn native_vless_endpoint_swap_preserves_dual_stack_listeners_and_tcp_flows() {
    native_endpoint_swap(false);
}

#[test]
#[ignore = "requires BROCADE_TEST_XRAY and IPv6 loopback; run serially"]
fn native_vless_endpoint_swap_preserves_mux_streams_and_counters() {
    native_endpoint_swap(true);
}

fn native_endpoint_swap(mux: bool) {
    let source = std::env::var_os("BROCADE_TEST_XRAY").expect("BROCADE_TEST_XRAY is required");
    let a = Echo::start(b'4');
    let b = Echo::start(b'6');
    let root = std::env::temp_dir().join(format!("be-{}", std::process::id()));
    assert!(!root.exists());
    super::create_private_dir(&root).unwrap();
    let mut fixture = Fixture {
        root: root.clone(),
        environment: ["BROCADE_XRAY_BIN", "BROCADE_TEST_LOG_SINK"]
            .into_iter()
            .map(|name| (name, std::env::var_os(name)))
            .collect(),
        receiver: None,
    };
    let binary = root.join("xray");
    std::fs::copy(source, &binary).unwrap();
    std::env::set_var("BROCADE_XRAY_BIN", &binary);
    std::env::set_var("BROCADE_TEST_LOG_SINK", "cat >/dev/null");
    let receiver = free_address();
    let udp_echo = UdpSocket::bind("127.0.0.1:0").unwrap();
    udp_echo
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let udp_target = udp_echo.local_addr().unwrap();
    let udp_port = UdpSocket::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let udp_worker = thread::spawn(move || {
        for _ in 0..2 {
            let mut bytes = [0; 4];
            let (len, peer) = udp_echo.recv_from(&mut bytes).unwrap();
            udp_echo.send_to(&bytes[..len], peer).unwrap();
        }
    });
    let uuid = "00000000-0000-4000-8000-000000000001";
    let receiver_config = json!({
        "log":{"loglevel":"error"},
        "inbounds":[
            {"tag":"receiver","listen":"0.0.0.0","port":receiver.port(),"protocol":"vless","settings":{"clients":[{"id":uuid}],"decryption":"none"}},
            {"tag":"udp","listen":"0.0.0.0","port":udp_port,"protocol":"dokodemo-door","settings":{"address":"127.0.0.1","port":udp_target.port(),"network":"udp"}}
        ],
        "outbounds":[
            {"tag":"v4","protocol":"freedom","settings":{"redirect":a.address.to_string(),"ipsBlocked":[]}},
            {"tag":"v6","protocol":"freedom","settings":{"redirect":b.address.to_string(),"ipsBlocked":[]}},
            {"tag":"udp-direct","protocol":"freedom","settings":{"ipsBlocked":[]}}
        ],
        "routing":{"rules":[
            {"type":"field","inboundTag":["udp"],"outboundTag":"udp-direct"},
            {"type":"field","source":["::1/128"],"outboundTag":"v6"}
        ]}
    });
    let receiver_path = root.join("receiver.json");
    super::write_private(&receiver_path, &receiver_config.to_string()).unwrap();
    fixture.receiver = Some(
        Command::new(&binary)
            .args(["run", "-config"])
            .arg(&receiver_path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while TcpStream::connect_timeout(&receiver, Duration::from_millis(50)).is_err() {
        assert!(Instant::now() < deadline, "receiver startup timed out");
        thread::sleep(Duration::from_millis(10));
    }
    for address in ["127.0.0.1", "::1"] {
        let ip: std::net::IpAddr = address.parse().unwrap();
        let socket = UdpSocket::bind(SocketAddr::new(ip, 0)).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        socket.connect(SocketAddr::new(ip, udp_port)).unwrap();
        socket.send(b"ping").unwrap();
        let mut reply = [0; 4];
        assert_eq!(socket.recv(&mut reply).unwrap(), 4);
        assert_eq!(&reply, b"ping");
    }
    udp_worker.join().unwrap();
    let api = free_address();
    let public = free_address();
    let public_v6 = SocketAddr::new("::1".parse().unwrap(), public.port());
    let mut content = json!({
        "log":{"loglevel":"error"},
        "stats":{},
        "policy":{"system":{"statsOutboundUplink":true,"statsOutboundDownlink":true}},
        "api":{"tag":"api","listen":api.to_string(),"services":["HandlerService","RoutingService","StatsService"]},
        "inbounds":[{"tag":"public","listen":"0.0.0.0","port":public.port(),"protocol":"dokodemo-door","settings":{"address":"127.0.0.1","port":a.address.port(),"network":"tcp"}}],
        "outbounds":[{"tag":"blocked","protocol":"blackhole"},{"tag":"out:app/chain>receiver","protocol":"vless","settings":{"vnext":[{"address":"127.0.0.1","port":receiver.port(),"users":[{"id":uuid,"encryption":"none"}]}]}}],
        "routing":{"rules":[{"type":"field","ruleTag":"unchanged","inboundTag":["public"],"outboundTag":"out:app/chain>receiver"}]}
    });
    if mux {
        content["outbounds"][1]["mux"] = json!({"enabled":true,"concurrency":8});
    }
    let checkpoint = root.join("xray.json");
    super::write_private(&checkpoint, &content.to_string()).unwrap();
    super::write_private(&root.join("usage-generation"), "1").unwrap();
    assert!(super::apply_xray(&checkpoint, api).unwrap().is_complete());
    let process = super::serving_xray_process_in(&root).unwrap();
    let mut original_tcp = connect(public);
    exchange(&mut original_tcp, b'4');
    exchange(&mut connect(public_v6), b'4');
    let server = format!("--server={api}");
    let call = |verb: &str, args: &[&str]| {
        let mut command = vec!["api", verb, server.as_str()];
        command.extend_from_slice(args);
        super::run_command(binary.to_str().unwrap(), &command)
    };
    let stage = |name: &str, payload: Value| {
        let path = root.join(name);
        super::write_private(&path, &payload.to_string())?;
        Ok(path)
    };
    let mut bridge_connections = Vec::new();
    let read_counters = || {
        crate::probe::hop_downlinks_from_stats(
            &crate::xray_grpc::query_stats(api, "outbound>>>").unwrap(),
        )
    };
    let mut counters = read_counters();
    for (round, (address, old_marker, new_marker)) in
        [("::1", b'4', b'6'), ("127.0.0.1", b'6', b'4')]
            .into_iter()
            .enumerate()
    {
        let before = content.to_string();
        content["outbounds"][1]["settings"]["vnext"][0]["address"] = address.into();
        let swap = hot_swap(&before, &content.to_string()).unwrap();
        assert_eq!(swap.operations().len(), 8);
        for (step, operation) in swap.operations().into_iter().enumerate() {
            super::apply_hot_swap_operation(operation, &call, &stage).unwrap();
            exchange(&mut original_tcp, b'4');
            let expected = if step < 2 { old_marker } else { new_marker };
            exchange(&mut connect(public), expected);
            exchange(&mut connect(public_v6), expected);
            if step == 3 {
                // The real tag is absent here; failed installation must leave the bridge usable.
                let invalid = HotSwapOperation::AddOutbounds(vec![
                    json!({"tag":"out:app/chain>receiver","protocol":"invalid-fixture-protocol"}),
                ]);
                assert!(super::apply_hot_swap_operation(invalid, &call, &stage).is_err());
                let mut bridged = connect(public);
                exchange(&mut bridged, new_marker);
                bridge_connections.push((bridged, new_marker));
                assert_eq!(std::fs::read_to_string(&checkpoint).unwrap(), before);
            }
            for (stream, marker) in &mut bridge_connections {
                exchange(stream, *marker);
            }
            let now = read_counters();
            for (tag, previous) in &counters {
                assert!(
                    now.get(tag).is_some_and(|value| value >= previous),
                    "counter reset during endpoint swap: {tag}"
                );
            }
            counters = now;
            assert_eq!(
                super::serving_xray_process_in(&root),
                Some(process),
                "round {round}, step {step}"
            );
        }
        super::write_private(&checkpoint, &content.to_string()).unwrap();
        let live: Value = serde_json::from_str(&call("lso", &[]).unwrap()).unwrap();
        let handlers = live["outbounds"].as_array().unwrap();
        assert_eq!(handlers.len(), 2);
        assert!(handlers
            .iter()
            .all(|out| !out["tag"].as_str().unwrap().ends_with(ENDPOINT_SWAP_SUFFIX)));
    }
    assert_eq!(
        counters.len(),
        2,
        "one canonical and one reusable temporary counter"
    );
    assert!(counters.values().all(|count| *count > 0));
    // Exercise the real ApplyXray entry point as well as the per-API boundary assertions.
    content["outbounds"][1]["settings"]["vnext"][0]["address"] = "::1".into();
    let encoded = content.to_string();
    let desired = brocade_deployment::plan::DesiredArtifact::Present {
        sha256: super::sha256_hex(encoded.as_bytes()),
        content: encoded.clone(),
    };
    super::converge_linux_xray(&root, &desired, false, Some((1920, 0)), true, None).unwrap();
    assert_eq!(super::serving_xray_process_in(&root), Some(process));
    assert_eq!(std::fs::read_to_string(&checkpoint).unwrap(), encoded);
    assert!(super::xrayupdate::read_upgrade_runtime(&root)
        .unwrap()
        .is_none());
    exchange(&mut original_tcp, b'4');
    exchange(&mut connect(public), b'6');
    exchange(&mut connect(public_v6), b'6');
    for (stream, marker) in &mut bridge_connections {
        exchange(stream, *marker);
    }

    // Idle connections must remain usable even when preparation exceeds five seconds.
    thread::sleep(Duration::from_secs(6));
    exchange(&mut original_tcp, b'4');

    // Simulate an Agent interruption after removing the canonical outbound. The retry
    // sees the old disk checkpoint and an existing bridge; it must recover through
    // handoff without stopping the old process or its established connections.
    let before = content.to_string();
    content["outbounds"][1]["settings"]["vnext"][0]["address"] = "127.0.0.1".into();
    let swap = hot_swap(&before, &content.to_string()).unwrap();
    for operation in swap.operations().into_iter().take(4) {
        super::apply_hot_swap_operation(operation, &call, &stage).unwrap();
    }
    exchange(&mut connect(public), b'4');
    let encoded = content.to_string();
    let desired = brocade_deployment::plan::DesiredArtifact::Present {
        sha256: super::sha256_hex(encoded.as_bytes()),
        content: encoded.clone(),
    };
    super::converge_linux_xray(&root, &desired, false, Some((1921, 0)), true, Some(&[])).unwrap();
    assert_eq!(std::fs::read_to_string(&checkpoint).unwrap(), encoded);
    let recovered = super::xrayupdate::read_upgrade_runtime(&root)
        .unwrap()
        .unwrap();
    assert_eq!(recovered.old.pid, process.pid);
    assert!(recovered.candidate.is_some());
    exchange(&mut original_tcp, b'4');
    exchange(&mut connect(public), b'4');
    exchange(&mut connect(public_v6), b'4');
    for (stream, marker) in &mut bridge_connections {
        exchange(stream, *marker);
    }
}
