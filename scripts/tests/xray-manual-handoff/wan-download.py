#!/usr/bin/env python3
"""Bounded authenticated download source/client for a manual WAN canary.

The client makes exactly one connection. It validates every sequenced frame and
never reconnects, retries, or resumes a partial download. Neither mode changes
network configuration or existing processes.
"""

import argparse
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import struct
import threading
import time
from urllib.parse import parse_qs, urlsplit

FRAME_SIZE = 65536
FILL = (bytes(range(256)) * 256)[8:]


def frame(sequence):
    return struct.pack("!Q", sequence) + FILL


def emit(event, **fields):
    print(json.dumps({"event": event, "unix_ms": round(time.time() * 1000), **fields}), flush=True)


def serve(arguments):
    token = arguments.token_file.read_text().strip()
    slots = threading.BoundedSemaphore(4)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_):
            pass  # URLs and authentication material never enter logs.

        def do_GET(self):
            self.connection.settimeout(10)
            self.close_connection = True
            if not hmac.compare_digest(self.headers.get("X-Canary-Token", ""), token):
                self.send_error(403)
                return
            try:
                parsed = urlsplit(self.path)
                query = parse_qs(parsed.query, strict_parsing=True)
                count = int(query["frames"][0])
                rate = int(query["rate"][0])
                if parsed.path != "/canary" or set(query) != {"frames", "rate"}:
                    raise ValueError("invalid request")
                if not 1 <= count <= 9600 or not 1 <= rate <= 32 or count / rate > 300:
                    raise ValueError("request exceeds bounded source limits")
            except (ValueError, KeyError):
                self.send_error(400)
                return
            if not slots.acquire(blocking=False):
                self.send_error(503)
                return
            sent = 0
            try:
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(count * FRAME_SIZE))
                self.send_header("Connection", "close")
                self.end_headers()
                started = time.monotonic()
                for sequence in range(count):
                    delay = started + sequence / rate - time.monotonic()
                    if delay > 0:
                        time.sleep(delay)
                    self.wfile.write(frame(sequence))
                    sent += 1
                emit("source_complete", frames=sent, payload_bytes=sent * FRAME_SIZE)
            except (TimeoutError, OSError) as error:
                emit("source_interrupted", frames=sent, error=type(error).__name__)
            finally:
                slots.release()

    server = ThreadingHTTPServer(("127.0.0.1", arguments.port), Handler)
    server.daemon_threads = True
    emit("source_ready", address="127.0.0.1", port=arguments.port)
    server.serve_forever()


def mptcp_identity(connection):
    if connection.getsockopt(socket.SOL_SOCKET, socket.SO_PROTOCOL) != 262:
        return None
    info = connection.getsockopt(284, 1, 80)
    if len(info) < 16:
        raise RuntimeError("short MPTCP_INFO")
    flags, token = struct.unpack_from("=II", info, 8)
    if flags & 1 or not flags & 2 or not token:
        raise RuntimeError("MPTCP fell back or was not negotiated")
    return {"flags": flags, "token": token}


def download(arguments):
    family = socket.AF_INET6 if ":" in arguments.host else socket.AF_INET
    token = arguments.token_file.read_text().strip()
    count = arguments.seconds * arguments.rate
    digest = hashlib.sha256()
    received = 0
    largest_gap = 0.0
    first = last = None
    request_bytes = 0
    started = time.monotonic()
    with socket.socket(family, socket.SOCK_STREAM, arguments.protocol) as connection:
        connection.settimeout(10)
        if arguments.mss:
            connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_MAXSEG, arguments.mss)
        if arguments.source_port:
            connection.bind((arguments.source_host or ("::" if family == socket.AF_INET6 else "0.0.0.0"), arguments.source_port))
        connection.connect((arguments.host, arguments.port))
        identity = mptcp_identity(connection)
        local = connection.getsockname()
        emit("connected", local=local, peer=connection.getpeername(), protocol=arguments.protocol,
             mptcp=identity, connect_calls=1, reconnect_calls=0)
        request = (f"GET /canary?frames={count}&rate={arguments.rate} HTTP/1.1\r\n"
                   f"Host: canary.invalid\r\nX-Canary-Token: {token}\r\nConnection: close\r\n\r\n").encode()
        request_bytes = len(request)
        connection.sendall(request)
        buffered = bytearray()
        while b"\r\n\r\n" not in buffered:
            block = connection.recv(4096)
            if not block:
                raise RuntimeError("EOF before response headers")
            buffered.extend(block)
            if len(buffered) > 16384:
                raise RuntimeError("oversized response header")
        header, body = bytes(buffered).split(b"\r\n\r\n", 1)
        if not header.startswith(b"HTTP/1.1 200 "):
            raise RuntimeError("download source did not return HTTP 200")
        fields = dict(line.split(b":", 1) for line in header.split(b"\r\n")[1:])
        if int(fields[b"Content-Length"].strip()) != count * FRAME_SIZE:
            raise RuntimeError("unexpected response size")
        header_bytes = len(header) + 4
        buffered = bytearray(body)
        for sequence in range(count):
            while len(buffered) < FRAME_SIZE:
                block = connection.recv(FRAME_SIZE - len(buffered))
                if not block:
                    raise RuntimeError(f"early EOF at frame {sequence}")
                buffered.extend(block)
            block = bytes(buffered[:FRAME_SIZE])
            del buffered[:FRAME_SIZE]
            if block != frame(sequence):
                raise RuntimeError(f"sequence/content mismatch at frame {sequence}")
            digest.update(block)
            received += len(block)
            now = time.monotonic()
            if last is not None:
                largest_gap = max(largest_gap, now - last)
            else:
                first = now
            last = now
            if sequence % (arguments.rate * 5) == 0:
                emit("progress", frames=sequence + 1, payload_bytes=received,
                     max_frame_gap_ms=round(largest_gap * 1000, 3))
        if buffered or connection.recv(1):
            raise RuntimeError("unexpected data after content length")
        if mptcp_identity(connection) != identity:
            raise RuntimeError("MPTCP connection identity changed")
    emit("passed", frames=count, payload_bytes=received, sha256=digest.hexdigest(),
         request_bytes=request_bytes, response_header_bytes=header_bytes,
         protocol=arguments.protocol, mptcp=identity, local=local,
         connect_calls=1, reconnect_calls=0,
         first_frame_ms=round((first - started) * 1000, 3),
         max_frame_gap_ms=round(largest_gap * 1000, 3),
         intentional_source_frame_interval_ms=1000 / arguments.rate,
         duration_ms=round((last - started) * 1000, 3))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("source", "client"))
    parser.add_argument("--token-file", type=Path, required=True)
    parser.add_argument("--host")
    parser.add_argument("--source-host")
    parser.add_argument("--source-port", type=int, default=0)
    parser.add_argument("--mss", type=int, default=1200, help="bounded canary MSS, not a PMTU certification")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--protocol", type=int, choices=(6, 262), default=6)
    parser.add_argument("--seconds", type=int, default=120)
    parser.add_argument("--rate", type=int, default=16, help="64 KiB frames per second, at most 32")
    arguments = parser.parse_args()
    if not 1 <= arguments.seconds <= 300 or not 1 <= arguments.rate <= 32:
        parser.error("bounded test limits exceeded")
    if arguments.mode == "client" and not arguments.host:
        parser.error("client requires --host")
    try:
        (serve if arguments.mode == "source" else download)(arguments)
    except Exception as error:
        emit("failed", error=str(error))
        raise


if __name__ == "__main__":
    main()
