#!/usr/bin/env python3
"""Unprivileged parser and fail-closed tests; never opens a netlink socket."""

import argparse
import importlib.util
import ipaddress
from pathlib import Path
import socket
import struct
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location(
    "wan_conntrack", Path(__file__).with_name("wan-conntrack.py"))
ct = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ct)
SOURCE = "2001:db8:1::1"
DESTINATION = "2001:db8:2::1"
SCOPE = {"source": SOURCE, "destination": DESTINATION,
         "source_ports": [61400, 61401], "destination_port": 40000}
SEQUENCE, PORT = 29, 1234


def attr(kind, payload):
    length = len(payload) + 4
    return struct.pack("=HH", length, kind) + payload + b"\0" * (ct.aligned(length) - length)


def integer(kind, value, size):
    return attr(kind, value.to_bytes(size, "big"))


def tuple_payload(source, destination, source_port, destination_port, protocol=6):
    addresses = attr(3, ipaddress.IPv6Address(source).packed)
    addresses += attr(4, ipaddress.IPv6Address(destination).packed)
    transport = integer(1, protocol, 1) + integer(2, source_port, 2)
    transport += integer(3, destination_port, 2)
    return attr(0x8001, addresses) + attr(0x8002, transport)


def payload(source=SOURCE, destination=DESTINATION, source_port=61401,
            destination_port=40000, reply_port=39742, protocol=6):
    data = struct.pack("!BBH", socket.AF_INET6, 0, 0)
    data += attr(0x8001, tuple_payload(source, destination, source_port, destination_port, protocol))
    data += attr(0x8002, tuple_payload(destination, source, reply_port, source_port, protocol))
    data += integer(3, 0x1ae, 4)
    data += attr(0x8004, attr(0x8001, integer(1, 3, 1)))
    data += integer(7, 599, 4)
    return data


def message(kind, body=b"", flags=2, sequence=SEQUENCE, port=PORT):
    length = ct.HEADER.size + len(body)
    return ct.HEADER.pack(length, kind, flags, sequence, port) + body


class FakeSocket:
    def __init__(self, datagrams):
        self.datagrams = iter(datagrams)

    def settimeout(self, value):
        self.timeout = value

    def recvmsg(self, size):
        result = next(self.datagrams)
        if isinstance(result, Exception):
            raise result
        if isinstance(result, tuple):
            return result
        return result, [], 0, (0, 0)


def collect(datagrams, **kwargs):
    return ct.collect(FakeSocket(datagrams), SEQUENCE, PORT, SCOPE,
                      kwargs.get("timeout", 1), kwargs.get("max_messages", 100))


class ParserTests(unittest.TestCase):
    def test_request_is_only_get_dump(self):
        request = ct.dump_request(SEQUENCE, PORT)
        self.assertEqual(len(request), 20)
        self.assertEqual(ct.HEADER.unpack_from(request), (20, 0x101, 0x301, SEQUENCE, PORT))
        self.assertEqual(request[16:], struct.pack("!BBH", socket.AF_INET6, 0, 0))

    def test_nat_entry_and_network_byte_order(self):
        row = ct.entry(payload(), **SCOPE)
        self.assertEqual(row["original"]["destination_port"], 40000)
        self.assertEqual(row["reply"]["source_port"], 39742)
        self.assertEqual(row["reply"]["destination_port"], 61401)
        self.assertEqual(row["original"]["source"], SOURCE)
        self.assertEqual(row["status"], 0x1ae)
        self.assertIn("DST_NAT", row["status_flags"])
        self.assertEqual(row["tcp_state_name"], "ESTABLISHED")
        self.assertEqual(row["timeout_seconds"], 599)
        self.assertEqual(row["zone"], 0)

    def test_baseline_is_not_mislabeled_as_nat(self):
        row = ct.entry(payload(source_port=61400, reply_port=40000), **SCOPE)
        self.assertEqual(row["reply"]["source_port"], 40000)

    def test_filter_uses_exact_original_tuple_and_tcp(self):
        cases = ({"source": "2001:db8:1::2"}, {"destination": "2001:db8:2::2"},
                 {"source_port": 61402}, {"destination_port": 39742}, {"protocol": 17})
        for kwargs in cases:
            with self.subTest(kwargs=kwargs):
                self.assertIsNone(ct.entry(payload(**kwargs), **SCOPE))

    def test_ipv4_dump_record_is_not_output(self):
        self.assertIsNone(ct.entry(bytes([socket.AF_INET]) + payload()[1:], **SCOPE))

    def test_truncated_and_duplicate_attributes_fail(self):
        for data in (b"\x00", struct.pack("=HH", 3, 1),
                     struct.pack("=HH", 9, 1) + b"\0", attr(1, b"a") * 2):
            with self.subTest(data=data), self.assertRaises(ValueError):
                ct.attributes(data)

    def test_matching_record_missing_fields_fails(self):
        with self.assertRaises(KeyError):
            ct.entry(payload()[:-8], **SCOPE)

    def test_invalid_scalar_length_fails(self):
        with self.assertRaises(ValueError):
            ct.number(b"\0", 4)

    def test_truncated_netlink_messages_fail(self):
        for data in (b"x", ct.HEADER.pack(8, ct.CT_NEW, 2, SEQUENCE, PORT),
                     message(ct.CT_NEW, payload())[:-1]):
            with self.subTest(data=data), self.assertRaises(ValueError):
                list(ct.messages(data))

    def test_complete_dump_filters_and_sorts(self):
        data = message(ct.CT_NEW, payload())
        data += message(ct.CT_NEW, payload(source_port=61402))
        data += message(ct.CT_NEW, payload(source_port=61400, reply_port=40000))
        data += message(ct.NLMSG_DONE, struct.pack("=i", 0))
        result = collect([data])
        self.assertTrue(result["complete"])
        self.assertEqual(result["matched"], 2)
        self.assertEqual(result["messages_scanned"], 4)
        self.assertEqual([row["original"]["source_port"] for row in result["entries"]], [61400, 61401])

    def test_empty_complete_dump(self):
        self.assertEqual(collect([message(ct.NLMSG_DONE)])["entries"], [])

    def test_data_after_completion_is_rejected(self):
        for tail in (b"x", message(ct.CT_NEW, payload())):
            with self.subTest(tail=tail), self.assertRaises(ValueError):
                collect([message(ct.NLMSG_DONE) + tail])

    def test_incomplete_dump_never_returns_partial_rows(self):
        for last in (message(ct.NLMSG_DONE, flags=ct.NLM_F_DUMP_INTR),
                     message(ct.NLMSG_DONE, struct.pack("=i", -4)),
                     message(ct.NLMSG_OVERRUN),
                     message(ct.NLMSG_ERROR, struct.pack("=i", -1)),
                     TimeoutError("timeout")):
            with self.subTest(last=last), self.assertRaises((OSError, ValueError)):
                collect([message(ct.CT_NEW, payload()), last])

    def test_unexpected_message_sequence_or_sender_fails(self):
        for data in (message(ct.NLMSG_DONE, sequence=30), message(ct.NLMSG_DONE, port=1235),
                     message(0x102), (message(ct.NLMSG_DONE), [], 0, (7, 0))):
            with self.subTest(data=data), self.assertRaises(ValueError):
                collect([data])

    def test_zero_error_ack_does_not_complete_dump(self):
        result = collect([message(ct.NLMSG_ERROR, struct.pack("=i", 0)), message(ct.NLMSG_DONE)])
        self.assertEqual(result["messages_scanned"], 2)

    def test_truncation_and_limits_fail(self):
        with self.assertRaisesRegex(ValueError, "truncated"):
            collect([(message(ct.NLMSG_DONE), [], socket.MSG_TRUNC, (0, 0))])
        with self.assertRaisesRegex(ValueError, "message limit"):
            collect([message(ct.CT_NEW, payload()) + message(ct.NLMSG_DONE)], max_messages=1)
        with mock.patch.object(ct, "MAX_BYTES", 1), self.assertRaisesRegex(ValueError, "byte limit"):
            collect([message(ct.NLMSG_DONE)])
        with mock.patch.object(ct, "MAX_MATCHES", 0), self.assertRaisesRegex(ValueError, "entry limit"):
            collect([message(ct.CT_NEW, payload())])

    def test_absolute_deadline(self):
        with self.assertRaises(TimeoutError):
            collect([], timeout=-1)

    def test_cli_scope_validation(self):
        self.assertEqual(ct.ipv6("2001:0db8:1::1"), SOURCE)
        for value in ("127.0.0.1", "::ffff:192.0.2.1", "fe80::1%eth0", "hostname"):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                ct.ipv6(value)
        self.assertEqual(ct.ports("61401,61400,61401"), [61400, 61401])
        for value in ("", "0", "65536", "61400,", "1," * 257):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                ct.ports(value)


if __name__ == "__main__":
    unittest.main()
