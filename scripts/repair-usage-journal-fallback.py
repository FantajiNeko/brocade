#!/usr/bin/env python3
"""Plan evidence-based corrections from retained usage_readings; never mutate a database.

Input is JSONL (optionally gzip), each row containing id, node, label, read_at seconds,
Xray start seconds, up, down, epoch, generation, instance, sequence. Rows must be in
database insertion order. Reproduce the original head acceptance rules, including
same-second no-ops, before finding a continuous journal -> process -> same journal.
Actual billed samples must be independently matched before applying this plan.
"""

import argparse
import gzip
import json
from collections import defaultdict
from pathlib import Path


def plan(rows):
    heads = {}
    pending = {}
    corrections = []
    unresolved = []
    previous_id = 0
    count = 0
    for row in rows:
        if len(row) != 11 or row[0] <= previous_id:
            raise ValueError("readings must have eleven fields and strictly increasing IDs")
        previous_id = row[0]
        count += 1
        key = (row[1], row[2])
        old = heads.get(key)
        if old is None:
            heads[key] = row
            continue
        if row[3] <= old[3]:
            continue
        if row[7] == old[7] and (row[5] < old[5] or row[6] < old[6]):
            continue
        active = pending.get(key)
        if active:
            if row[7] == active['journal'] and row[5] >= old[5] and row[6] >= old[6]:
                # The journal itself proves continuity; never infer it merely from big counters.
                corrections.extend([
                    correction(active['before'], active['fallback']),
                    correction(old, row),
                ])
                del pending[key]
            elif row[7] != active['process'] or row[5] < old[5] or row[6] < old[6]:
                unresolved.append(active)
                del pending[key]
        elif (old[7].startswith('journal:') and not row[7].startswith('journal:')
              and row[4] <= old[3] and row[5] >= old[5] and row[6] >= old[6]):
            pending[key] = {'journal': old[7], 'process': row[7], 'before': old, 'fallback': row}
        heads[key] = row
    unresolved.extend(pending.values())
    totals = defaultdict(lambda: {'up': 0, 'down': 0, 'readings': 0})
    for item in corrections:
        total = totals[item['node']]
        total['up'] += item['subtract_up']
        total['down'] += item['subtract_down']
        total['readings'] += 1
    return {'scanned_readings': count, 'by_node': dict(sorted(totals.items())),
            'corrections': corrections, 'unresolved': unresolved}


def correction(before, current):
    return {'node': current[1], 'label': current[2], 'reading_id': current[0],
            'previous_reading_id': before[0], 'window_start': max(before[3], current[4]),
            'window_end': current[3], 'generation': current[8],
            'subtract_up': before[5], 'subtract_down': before[6],
            'original_up': current[5], 'original_down': current[6],
            'real_up': current[5] - before[5], 'real_down': current[6] - before[6]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('readings', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    opener = gzip.open if args.readings.suffix == '.gz' else open
    with opener(args.readings, 'rt') as source:
        result = plan(json.loads(line) for line in source if line.strip())
    with args.output.open('x') as target:
        args.output.chmod(0o600)
        json.dump(result, target, indent=2)
        target.write('\n')
    print(json.dumps({'scanned_readings': result['scanned_readings'],
                      'by_node': result['by_node'], 'unresolved': len(result['unresolved'])}))


if __name__ == '__main__':
    main()
