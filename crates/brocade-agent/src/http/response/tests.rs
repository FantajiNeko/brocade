use super::*;
use crate::http::{AddressFamily, HttpClient};
use std::{net::TcpListener, sync::mpsc, thread, time::Duration};

struct Fragmented<'a> {
    bytes: &'a [u8],
    fragment: usize,
    end: io::ErrorKind,
}

impl Read for Fragmented<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.bytes.is_empty() {
            return Err(io::Error::new(self.end, "fixture end"));
        }
        let length = buffer.len().min(self.bytes.len()).min(self.fragment);
        buffer[..length].copy_from_slice(&self.bytes[..length]);
        self.bytes = &self.bytes[length..];
        Ok(length)
    }
}

fn never_closed(bytes: &[u8], fragment: usize) -> Fragmented<'_> {
    Fragmented {
        bytes,
        fragment,
        end: io::ErrorKind::WouldBlock,
    }
}

#[test]
fn length_chunked_and_bodyless_finish_without_an_extra_socket_read() {
    for (method, bytes, expected) in [
        ("GET", &b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello"[..], "hello"),
        ("POST", &b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"[..], "{}"),
        ("GET", &b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"[..], ""),
        ("GET", &b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhe\r\n3;x=y\r\nllo\r\n0\r\nX-End: yes\r\n\r\n"[..], "hello"),
        ("GET", &b"HTTP/1.1 204 No Content\r\n\r\n"[..], ""),
        ("GET", &b"HTTP/1.1 304 Not Modified\r\nContent-Length: 999999999\r\n\r\n"[..], ""),
        ("HEAD", &b"HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\n\r\n"[..], ""),
    ] {
        for fragment in 1..=bytes.len() {
            let response = read_response(never_closed(bytes, fragment), method).unwrap();
            assert_eq!(response.body, expected, "{method}, fragment={fragment}");
        }
    }
}

#[test]
fn real_http_client_does_not_wait_for_connection_close_or_replay_post() {
    for (method, wire, status, body) in [
        (
            "GET",
            &b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: keep-alive\r\n\r\nhello"[..],
            200,
            "hello",
        ),
        (
            "POST",
            &b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"[..],
            200,
            "{}",
        ),
        (
            "GET",
            &b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n"[..],
            200,
            "hello",
        ),
        ("GET", &b"HTTP/1.1 204 No Content\r\n\r\n"[..], 204, ""),
        (
            "HEAD",
            &b"HTTP/1.1 200 OK\r\nContent-Length: 4096\r\n\r\n"[..],
            200,
            "",
        ),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (release, wait_release) = mpsc::channel();
        let server = thread::spawn(move || {
            use std::io::Write;
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(&mut stream);
            loop {
                let mut line = String::new();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
            }
            stream.write_all(wire).unwrap();
            // Hold the socket open until the client has returned, including on
            // test failure; correctness does not depend on a timing assertion.
            wait_release.recv_timeout(Duration::from_secs(2)).unwrap();
            listener.set_nonblocking(true).unwrap();
            assert!(
                matches!(listener.accept(), Err(error) if error.kind() == io::ErrorKind::WouldBlock)
            );
        });
        let client = HttpClient::new(&format!("http://{address}")).unwrap();
        let result = client.request_public_on_family(
            AddressFamily::V4,
            method,
            "/",
            Duration::from_millis(100),
        );
        release.send(()).unwrap();
        server.join().unwrap();
        let response = result.unwrap();
        assert_eq!(response.status, status);
        assert_eq!(response.body, body);
    }
}

#[test]
fn interim_responses_are_skipped_and_final_headers_are_retained() {
    let wire = b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early Hints\r\nX-Early: ignored\r\n\r\nHTTP/1.1 200 OK\r\nX-Final: yes\r\nContent-Length: 2\r\n\r\n{}";
    for fragment in [1, 7, 8192] {
        let response = read_response(never_closed(wire, fragment), "GET").unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body, "{}");
        assert_eq!(response.header("x-final"), Some("yes"));
        assert_eq!(response.header("x-early"), None);
    }
    assert!(read_response(&b"HTTP/1.1 100 Continue\r\n\r\n"[..], "POST").is_err());
    assert!(read_response(
        never_closed(b"HTTP/1.1 101 Switching Protocols\r\n\r\n", 1),
        "GET"
    )
    .unwrap_err()
    .contains("unsupported"));
}

#[test]
fn a_truncated_post_response_is_not_replayed() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        use std::io::Write;
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut reader = BufReader::new(&mut stream);
        loop {
            let mut line = String::new();
            assert!(reader.read_line(&mut line).unwrap() > 0);
            if line == "\r\n" {
                break;
            }
        }
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n{}")
            .unwrap();
        // Dropping the listener makes any incorrect retry fail immediately.
    });
    let client = HttpClient::new(&format!("http://{address}")).unwrap();
    let error = client.request_public("POST", "/", None).unwrap_err();
    server.join().unwrap();
    assert!(error.contains("ended before Content-Length"), "{error}");
}

#[test]
fn content_length_is_bytes_and_does_not_include_a_following_response() {
    let wire = "HTTP/1.1 200 OK\r\ncOnTeNt-LeNgTh: 6\r\n\r\n你好HTTP/1.1 500 next\r\n\r\nsecret";
    let response = read_response(wire.as_bytes(), "GET").unwrap();
    assert_eq!(response.body, "你好");
    let response = read_response(
        &b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\nextra"[..],
        "GET",
    )
    .unwrap();
    assert!(response.body.is_empty());
}

#[test]
fn truncated_length_and_chunked_responses_fail_even_on_tls_eof() {
    for bytes in [
        &b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n{}"[..],
        &b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel"[..],
        &b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n"[..],
        &b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n"[..],
        &b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX-End: yes\r\n"[..],
        &b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n"[..],
    ] {
        assert!(read_response(bytes, "GET").is_err());
        assert!(read_response(
            Fragmented {
                bytes,
                fragment: 1,
                end: io::ErrorKind::UnexpectedEof
            },
            "GET"
        )
        .is_err());
        // A timeout before the actual boundary must not become a successful response.
        let error = read_response(never_closed(bytes, 7), "GET").unwrap_err();
        assert!(error.contains("fixture end"), "{error}");
    }
}

#[test]
fn only_close_delimited_responses_wait_for_eof() {
    let wire = b"HTTP/1.0 200 OK\r\n\r\nhello";
    assert_eq!(read_response(&wire[..], "GET").unwrap().body, "hello");
    assert_eq!(
        read_response(
            Fragmented {
                bytes: wire,
                fragment: 3,
                end: io::ErrorKind::UnexpectedEof
            },
            "GET"
        )
        .unwrap()
        .body,
        "hello"
    );
    assert!(read_response(never_closed(wire, 3), "GET")
        .unwrap_err()
        .contains("fixture end"));
}

#[test]
fn duplicate_lengths_must_all_agree() {
    for fields in [
        "Content-Length: 2\r\nContent-Length: 2",
        "Content-Length: 2, 2",
        "Content-Length: 02\r\ncontent-length: 2, 02",
    ] {
        let raw = format!("HTTP/1.1 200 OK\r\n{fields}\r\n\r\n{{}}");
        assert_eq!(
            read_response(never_closed(raw.as_bytes(), 1), "GET")
                .unwrap()
                .body,
            "{}"
        );
    }
    for fields in [
        "Content-Length: 2\r\nContent-Length: 3",
        "Content-Length: 2, 3",
        "Content-Length: -1",
        "Content-Length: +2",
        "Content-Length:",
        "Content-Length: 2,",
        "Content-Length: 0x2",
        "Content-Length: 99999999999999999999999999999999999",
    ] {
        let raw = format!("HTTP/1.1 200 OK\r\n{fields}\r\n\r\n");
        let error = read_response(never_closed(raw.as_bytes(), 1), "GET").unwrap_err();
        assert!(error.contains("Content-Length"), "{error}");
        assert!(!error.contains("fixture end"), "{error}");
    }
}

#[test]
fn ambiguous_or_unsupported_transfer_framing_is_rejected_before_body_read() {
    for fields in [
        "Transfer-Encoding: chunked\r\nContent-Length: 0",
        "Transfer-Encoding: chunked\r\nTransfer-Encoding: chunked",
        "Transfer-Encoding: chunked, gzip",
        "Transfer-Encoding: gzip, chunked",
        "Transfer-Encoding: gzip",
        "Transfer-Encoding:",
    ] {
        let raw = format!("HTTP/1.1 200 OK\r\n{fields}\r\n\r\n");
        let error = read_response(never_closed(raw.as_bytes(), 1), "GET").unwrap_err();
        assert!(error.contains("Transfer-Encoding"), "{error}");
    }
}

#[test]
fn trailers_cannot_overwrite_response_headers_or_change_framing() {
    let response = read_response(never_closed(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nX-Policy: original\r\n\r\n0\r\nX-Policy: replaced\r\n\r\n", 1), "GET").unwrap();
    assert_eq!(response.header("x-policy"), Some("original"));
    for trailer in [
        "Content-Length: 0",
        "Transfer-Encoding: chunked",
        "not-a-field",
    ] {
        let raw =
            format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n{trailer}\r\n\r\n");
        assert!(read_response(raw.as_bytes(), "GET").is_err());
    }
}

#[test]
fn wire_limit_includes_headers_chunk_metadata_and_trailers() {
    let header = b"HTTP/1.1 200 OK\r\n\r\n";
    let mut raw = header.to_vec();
    raw.resize(MAX_HTTP_RESPONSE_BYTES, b'x');
    assert_eq!(
        read_response(&raw[..], "GET").unwrap().body.len(),
        MAX_HTTP_RESPONSE_BYTES - header.len()
    );
    raw.push(b'x');
    assert!(read_response(&raw[..], "GET")
        .unwrap_err()
        .contains("exceeds"));

    for head in [
        format!("HTTP/1.1 200 OK\r\nContent-Length: {MAX_HTTP_RESPONSE_BYTES}\r\n\r\n"),
        format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{MAX_HTTP_RESPONSE_BYTES:x}\r\n"
        ),
    ] {
        assert!(read_response(never_closed(head.as_bytes(), 8192), "GET")
            .unwrap_err()
            .contains("exceeds"));
    }
    for prefix in [
        "HTTP/1.1 200 OK\r\nX-Long: ",
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX-Long: ",
    ] {
        let mut raw = prefix.as_bytes().to_vec();
        raw.resize(MAX_HTTP_RESPONSE_BYTES + 1, b'x');
        assert!(read_response(&raw[..], "GET")
            .unwrap_err()
            .contains("exceeds"));
    }
}
