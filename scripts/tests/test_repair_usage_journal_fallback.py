import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'repair', Path(__file__).resolve().parents[1] / 'repair-usage-journal-fallback.py')
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


def row(number, at, epoch, up, down, started=1):
    return [number, 'node', 'user#entry', at, started, up, down, epoch, 1, 'instance', number]


class JournalCorrectionTests(unittest.TestCase):
    def test_same_second_restore_does_not_hide_later_full_rebilling(self):
        result = repair.plan([
            row(1, 100, 'journal:a', 1000, 2000),
            row(2, 101, 'process:b', 1001, 2002),
            row(3, 101, 'journal:a', 1002, 2004),
            row(4, 131, 'journal:a', 1010, 2020),
        ])
        self.assertEqual([x['reading_id'] for x in result['corrections']], [2, 4])
        self.assertEqual([(x['real_up'], x['real_down']) for x in result['corrections']], [(1, 2), (9, 18)])
        self.assertEqual(result['by_node']['node']['up'], 2001)
        self.assertFalse(result['unresolved'])

    def test_real_legacy_restart_and_different_journal_are_never_inferred(self):
        for rows in [
            [row(1, 100, 'journal:a', 1000, 2000), row(2, 120, 'legacy:b', 2000, 3000, 110), row(3, 140, 'journal:a', 3000, 4000, 130)],
            [row(1, 100, 'journal:a', 1000, 2000), row(2, 101, 'process:b', 1001, 2001), row(3, 120, 'journal:c', 1002, 2002)],
        ]:
            self.assertFalse(repair.plan(rows)['corrections'])

    def test_regression_preserves_the_last_accepted_head(self):
        result = repair.plan([
            row(1, 100, 'journal:a', 1000, 2000),
            row(2, 101, 'process:b', 1010, 2020),
            row(3, 102, 'process:b', 5, 10),
            row(4, 130, 'journal:a', 1030, 2060),
        ])
        self.assertEqual(result['corrections'][1]['subtract_up'], 1010)
        self.assertEqual(result['corrections'][1]['real_up'], 20)

    def test_incomplete_evidence_and_unsorted_input_are_rejected(self):
        result = repair.plan([row(1, 100, 'journal:a', 10, 20), row(2, 101, 'process:b', 11, 22)])
        self.assertFalse(result['corrections'])
        self.assertEqual(len(result['unresolved']), 1)
        with self.assertRaises(ValueError):
            repair.plan([row(2, 100, 'journal:a', 10, 20), row(1, 101, 'process:b', 11, 22)])


if __name__ == '__main__':
    unittest.main()
