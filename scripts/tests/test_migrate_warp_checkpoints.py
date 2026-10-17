import copy
import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location("migration", Path(__file__).parents[1] / "migrate-warp-checkpoints.py")
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


def checkpoint():
    return {"external_outbounds": [{
        "id": "warp-test", "tenant": "test", "name": "测试",
        "address": "engage.cloudflareclient.com", "port": 2408,
        "protocol": {"t": "warp", "v": {"mtu": 1280, "allowed_ips": ["0.0.0.0/0", "::/0"]}},
        "security": {"t": "none"}, "bindings": [],
    }], "unrelated": {"sealed": "test-only"}}


class MigrationTests(unittest.TestCase):
    def test_converts_only_unused_options_and_endpoint(self):
        original = checkpoint()
        saved = copy.deepcopy(original)
        converted, count = migration.convert(original)
        self.assertEqual(count, 1)
        self.assertEqual(original, saved)
        expected = checkpoint()
        expected["external_outbounds"][0].update(address="162.159.198.2", port=443)
        expected["external_outbounds"][0]["protocol"]["v"] = migration.MASQUE_OPTIONS
        self.assertEqual(converted, expected)
        self.assertEqual(migration.convert(converted), (converted, 0))

    def test_rejects_bound_and_referenced(self):
        for usage in ("binding", "rule", "model_front", "client_front"):
            with self.subTest(usage=usage):
                document = checkpoint()
                if usage == "binding":
                    document["external_outbounds"][0]["bindings"] = [{"node": "node-test"}]
                elif usage == "rule":
                    document["apps"] = [{"steps": [{"rules": [{"a": {"t": "proxy", "outbound": "warp-test"}}]}]}]
                elif usage == "model_front":
                    document["apps"] = [{"fronts": [{"external_via": ["warp-test"]}]}]
                else:
                    document["fronts"] = {"front-test": {"external_via": ["warp-test"]}}
                with self.assertRaises(ValueError):
                    migration.convert(document)

    def test_rejects_mixed_unknown_and_custom_endpoints(self):
        for change in ("mixed", "unknown", "endpoint", "security", "bindings"):
            with self.subTest(change=change):
                document = checkpoint()
                outbound = document["external_outbounds"][0]
                if change in ("mixed", "unknown"):
                    outbound["protocol"]["v"]["http_version" if change == "mixed" else "typo"] = "h3"
                elif change == "endpoint":
                    outbound["address"] = "custom.example"
                elif change == "security":
                    outbound["security"] = {"t": "tls"}
                else:
                    outbound["bindings"] = None
                with self.assertRaises(ValueError):
                    migration.convert(document)

    def test_client_hash_is_checked_before_any_mutation(self):
        original = checkpoint()
        row = {"kind": "client", "id": 1, "document": original, "hash": "0" * 64}
        with self.assertRaises(ValueError):
            migration.prepare([row])
        row["hash"] = migration.digest(original)
        records, report = migration.prepare([row])
        self.assertEqual(records[0][4], row["hash"])
        self.assertNotEqual(report[0]["before_sha256"], report[0]["after_sha256"])
        self.assertEqual(records[0][5], report[0]["after_sha256"])


if __name__ == "__main__":
    unittest.main()
