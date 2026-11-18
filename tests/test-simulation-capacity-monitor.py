import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

path = Path(__file__).resolve().parents[1] / 'automation/monitoring/simulation_capacity.py'
spec = importlib.util.spec_from_file_location('monitor', path)
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


def healthy(active=0, ready=True, configured=4):
    return {'status': 'ok', 'capacity': {'devices': [
        {'key': '0', 'host': 'node', 'gpu': 0, 'configured': configured,
         'ready': ready, 'reason': 'ready' if ready else 'disconnected',
         'active': active, 'free': configured - active}]}}


class Collector:
    @staticmethod
    def observe(root, fetch):
        monitor.atomic_json(Path(root) / 'latest.json', fetch())


class CapacityMonitorTests(unittest.TestCase):
    def test_load_changes_do_not_wake_ai_but_four_hour_review_does(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertFalse(monitor.check(Collector, root, healthy, baseline=True, now=0)['trigger'])
            for now in range(900, 14400, 900):
                result = monitor.check(Collector, root, lambda: healthy(active=(now // 900) % 5), now=now)
                self.assertFalse(result['trigger'])
            self.assertEqual(monitor.check(Collector, root, healthy, now=14400)['reason'], 'periodic_review')

    def test_new_fault_and_recovery_bypass_routine_interval_without_repeating(self):
        with tempfile.TemporaryDirectory() as root:
            monitor.check(Collector, root, healthy, baseline=True, now=0)
            first = monitor.check(Collector, root, lambda: healthy(ready=False), now=900)
            self.assertEqual(first['reason'], 'new_anomaly')
            self.assertFalse(monitor.check(Collector, root, lambda: healthy(ready=False), now=1800)['trigger'])
            evidence = json.loads((Path(root) / 'review-latest.json').read_text())
            original = json.loads(Path(evidence['reviewEvidence']).read_text())
            self.assertEqual(original['decision']['reason'], 'new_anomaly')
            self.assertEqual(original['checkedAt'], 900)
            recovered = monitor.check(Collector, root, healthy, now=2700)
            self.assertEqual(recovered['reason'], 'recovered')
            again = monitor.check(Collector, root, lambda: healthy(ready=False), now=3600)
            self.assertNotEqual(first['dedupeKey'], again['dedupeKey'])

    def test_read_failure_is_visible_and_repeated_errors_are_coalesced(self):
        def fail():
            raise TimeoutError('unreachable')
        with tempfile.TemporaryDirectory() as root:
            monitor.check(Collector, root, healthy, baseline=True, now=0)
            self.assertTrue(monitor.check(Collector, root, fail, now=900)['trigger'])
            self.assertFalse(monitor.check(Collector, root, fail, now=1800)['trigger'])
            evidence = json.loads((Path(root) / 'review-latest.json').read_text())
            self.assertEqual(evidence['current']['status'], 'error')
            self.assertIn('TimeoutError', evidence['current']['error'])
            self.assertEqual(monitor.check(Collector, root, healthy, now=2700)['reason'], 'recovered')

    def test_config_change_and_empty_registry(self):
        with tempfile.TemporaryDirectory() as root:
            monitor.check(Collector, root, healthy, baseline=True, now=0)
            self.assertEqual(monitor.check(Collector, root, lambda: healthy(configured=8), now=900)['reason'], 'capacity_configuration_changed')
            result = monitor.check(Collector, root, lambda: {'status': 'ok', 'capacity': {'devices': []}}, now=1800)
            self.assertEqual(result['reason'], 'new_anomaly')

    def test_unhealthy_baseline_does_not_silence_first_real_check(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ValueError):
                monitor.check(Collector, root, lambda: healthy(ready=False), baseline=True, now=0)
            self.assertTrue(monitor.check(Collector, root, lambda: healthy(ready=False), now=900)['trigger'])

    def test_review_interval_is_configurable(self):
        with tempfile.TemporaryDirectory() as root:
            monitor.check(Collector, root, healthy, baseline=True, now=0)
            self.assertEqual(monitor.check(Collector, root, healthy, review_seconds=1800, now=1800)['reason'], 'periodic_review')


if __name__ == '__main__':
    unittest.main()
