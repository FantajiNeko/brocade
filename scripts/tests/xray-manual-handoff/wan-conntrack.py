#!/usr/bin/env python3
"""Read-only, bounded IPv6 TCP conntrack evidence for a handoff canary.

Only CT_GET|DUMP is sent; no counters are reset and no entries are modified.
An incomplete/interrupted dump fails without printing partial entries. A complete
dump is not an atomic snapshot: also check sockets and stop new test connections
before using an empty result as evidence of draining.
"""

import argparse
import ipaddress
import json
import secrets
import socket
import struct
import sys
import time


NETLINK_NETFILTER = 12
CT_NEW = 0x100
CT_GET = 0x101
NLM_F_REQUEST_DUMP = 0x301
NLM_F_DUMP_INTR = 0x10
NLMSG_NOOP, NLMSG_ERROR, NLMSG_DONE, NLMSG_OVERRUN = 1, 2, 3, 4
HEADER = struct.Struct("=IHHII")
MAX_BYTES = 64 * 1024 * 1024
MAX_MATCHES = 1024
RECV_BYTES = 1024 * 1024
TCP_STATES = (
    "NONE", "SYN_SENT", "SYN_RECV", "ESTABLISHED", "FIN_WAIT",
    "CLOSE_WAIT", "LAST_ACK", "TIME_WAIT", "CLOSE", "SYN_SENT2",
)
STATUS_FLAGS = (
    "EXPECTED", "SEEN_REPLY", "ASSURED", "CONFIRMED", "SRC_NAT",
    "DST_NAT", "SEQ_ADJUST", "SRC_NAT_DONE", "DST_NAT_DONE", "DYING",
    "FIXED_TIMEOUT", "TEMPLATE", "UNTRACKED", "HELPER", "OFFLOAD",
    "HW_OFFLOAD",
)


def aligned(length):
    return (length + 3) & ~3


def attributes(data):
    result = {}
    offset = 0
    while offset < len(data):
        if len(data) - offset < 4:
            raise ValueError("truncated netlink attribute header")
        length, kind = struct.unpack_from("=HH", data, offset)
        if length < 4 or offset + length > len(data):
            raise ValueError("invalid netlink attribute length")
        kind &= 0x3fff
        if kind in result and kind != 0:
            raise ValueError("duplicate netlink attribute")
        result[kind] = data[offset + 4:offset + length]
        next_offset = offset + aligned(length)
        if next_offset > len(data) and offset + length != len(data):
            raise ValueError("truncated netlink attribute padding")
        offset = next_offset
    return result


def number(data, size):
    if len(data) != size:
        raise ValueError("invalid conntrack scalar length")
    return int.from_bytes(data, "big")


def tcp_tuple(data):
    fields = attributes(data)
    protocol = attributes(fields[2])
    if number(protocol[1], 1) != socket.IPPROTO_TCP:
        return None
    addresses = attributes(fields[1])
    if len(addresses[3]) != 16 or len(addresses[4]) != 16:
        raise ValueError("invalid IPv6 conntrack address")
    return {
        "source": str(ipaddress.IPv6Address(addresses[3])),
        "destination": str(ipaddress.IPv6Address(addresses[4])),
        "source_port": number(protocol[2], 2),
        "destination_port": number(protocol[3], 2),
        "protocol": socket.IPPROTO_TCP,
    }


def entry(payload, source, destination, source_ports, destination_port):
    if len(payload) < 4:
        raise ValueError("truncated nfgenmsg")
    family, version, _ = struct.unpack_from("!BBH", payload)
    if version != 0:
        raise ValueError("unsupported nfnetlink version")
    if family != socket.AF_INET6:
        return None
    fields = attributes(payload[4:])
    original = tcp_tuple(fields[1])
    if original is None or (
        original["source"] != source
        or original["destination"] != destination
        or original["source_port"] not in source_ports
        or original["destination_port"] != destination_port
    ):
        return None
    reply = tcp_tuple(fields[2])
    if reply is None:
        raise ValueError("TCP original tuple has a non-TCP reply")
    status = number(fields[3], 4)
    protocol_info = attributes(fields[4])
    tcp_info = attributes(protocol_info[1])
    state = number(tcp_info[1], 1)
    return {
        "original": original,
        "reply": reply,
        "status": status,
        "status_flags": [name for bit, name in enumerate(STATUS_FLAGS)
                         if status & (1 << bit)],
        "tcp_state": state,
        "tcp_state_name": TCP_STATES[state] if state < len(TCP_STATES) else "UNKNOWN",
        "timeout_seconds": number(fields[7], 4),
        "zone": number(fields[18], 2) if 18 in fields else 0,
    }


def messages(data):
    offset = 0
    while offset < len(data):
        if len(data) - offset < HEADER.size:
            raise ValueError("truncated netlink message header")
        length, kind, flags, sequence, port = HEADER.unpack_from(data, offset)
        if length < HEADER.size or offset + length > len(data):
            raise ValueError("invalid netlink message length")
        yield kind, flags, sequence, port, data[offset + HEADER.size:offset + length]
        next_offset = offset + aligned(length)
        if next_offset > len(data) and offset + length != len(data):
            raise ValueError("truncated netlink message padding")
        offset = next_offset


def dump_request(sequence, port):
    # Deliberately no configurable operation or attributes: never CT_DELETE,
    # CT_GET_CTRZERO, CT_NEW, or a batch containing mutations.
    body = struct.pack("!BBH", socket.AF_INET6, 0, 0)
    return HEADER.pack(HEADER.size + len(body), CT_GET, NLM_F_REQUEST_DUMP,
                       sequence, port) + body


def collect(sock, sequence, port, scope, timeout, max_messages):
    deadline = time.monotonic() + timeout
    rows = []
    received_bytes = 0
    received_messages = 0
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("conntrack dump deadline exceeded")
        sock.settimeout(remaining)
        data, _, flags, sender = sock.recvmsg(RECV_BYTES)
        if sender != (0, 0):
            raise ValueError("conntrack message is not from the kernel unicast socket")
        if flags & socket.MSG_TRUNC:
            raise ValueError("conntrack dump datagram truncated")
        if not data:
            raise ValueError("empty conntrack dump datagram")
        received_bytes += len(data)
        if received_bytes > MAX_BYTES:
            raise ValueError("conntrack dump byte limit exceeded")
        done = False
        for kind, msg_flags, msg_sequence, msg_port, payload in messages(data):
            if done:
                raise ValueError("unexpected data after conntrack dump completion")
            if time.monotonic() >= deadline:
                raise TimeoutError("conntrack dump deadline exceeded")
            received_messages += 1
            if received_messages > max_messages:
                raise ValueError("conntrack dump message limit exceeded")
            if msg_sequence != sequence or msg_port not in (0, port):
                raise ValueError("conntrack dump sequence or port mismatch")
            if msg_flags & NLM_F_DUMP_INTR:
                raise ValueError("conntrack dump interrupted; result is incomplete")
            if kind == NLMSG_DONE:
                if payload and (len(payload) < 4 or struct.unpack_from("=i", payload)[0]):
                    raise ValueError("conntrack dump completion reports an error")
                done = True
                continue
            if kind == NLMSG_ERROR:
                if len(payload) < 4:
                    raise ValueError("truncated netlink error")
                error = struct.unpack_from("=i", payload)[0]
                if error:
                    raise OSError(abs(error), "kernel rejected read-only conntrack dump")
            elif kind == NLMSG_OVERRUN:
                raise ValueError("conntrack dump overrun; result is incomplete")
            elif kind == CT_NEW:
                row = entry(payload, **scope)
                if row is not None:
                    if len(rows) >= MAX_MATCHES:
                        raise ValueError("conntrack matching entry limit exceeded")
                    rows.append(row)
            elif kind != NLMSG_NOOP:
                raise ValueError("unexpected conntrack netlink message type")
        if done:
            rows.sort(key=lambda row: (row["original"]["source_port"], row["zone"],
                                      row["reply"]["source_port"]))
            return {"complete": True, "messages_scanned": received_messages,
                    "matched": len(rows), "entries": rows}


def ipv6(value):
    try:
        address = ipaddress.IPv6Address(value)
        if address.scope_id or address.ipv4_mapped:
            raise ValueError("scoped or IPv4-mapped address")
        return str(address)
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected an unscoped native IPv6 address") from error


def bounded_integer(lower, upper):
    def parse(value):
        try:
            result = int(value)
        except ValueError as error:
            raise argparse.ArgumentTypeError("expected an integer") from error
        if not lower <= result <= upper:
            raise argparse.ArgumentTypeError(f"expected {lower}..{upper}")
        return result
    return parse


def ports(value):
    parts = value.split(",")
    if not 1 <= len(parts) <= 256:
        raise argparse.ArgumentTypeError("expected 1..256 comma-separated source ports")
    return sorted({bounded_integer(1, 65535)(part) for part in parts})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=ipv6)
    parser.add_argument("--destination", required=True, type=ipv6)
    parser.add_argument("--source-ports", required=True, type=ports)
    parser.add_argument("--destination-port", default=40000, type=bounded_integer(1, 65535))
    parser.add_argument("--timeout", default=8, type=bounded_integer(1, 30))
    parser.add_argument("--max-messages", default=50000, type=bounded_integer(1, 100000))
    args = parser.parse_args()
    scope = {key: getattr(args, key) for key in
             ("source", "destination", "source_ports", "destination_port")}
    try:
        with socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, NETLINK_NETFILTER) as sock:
            sock.settimeout(args.timeout)
            sock.bind((0, 0))
            port = sock.getsockname()[0]
            sequence = secrets.randbelow(0xffffffff) + 1
            request = dump_request(sequence, port)
            if sock.sendto(request, (0, 0)) != len(request):
                raise OSError("short conntrack dump request")
            result = collect(sock, sequence, port, scope, args.timeout, args.max_messages)
        result["scope"] = scope
        result["unix_ms"] = round(time.time() * 1000)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError, struct.error) as error:
        print(json.dumps({"complete": False, "error": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
