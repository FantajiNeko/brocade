#!/usr/bin/env python3
"""Check saved namespace profiles and wire counters without driving any traffic."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent / "netlab"))
from probe import counter_delta, validate_profile

directory = Path(sys.argv[1])
before = json.loads((directory / "before.json").read_text())
after = json.loads((directory / "after.json").read_text())
validate_profile(before)
validate_profile(after)
print(json.dumps({
    "profile": before["profile"],
    "interval_seconds": (after["monotonic_ns"] - before["monotonic_ns"]) / 1e9,
    "interface_deltas": counter_delta(before, after),
    "scope": "shared host kernel, four-CPU cpuset; correctness traffic, no performance SLO or billing claim",
}, indent=2))
