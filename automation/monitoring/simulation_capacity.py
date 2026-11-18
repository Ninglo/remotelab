#!/usr/bin/env python3
"""Script-first capacity checks around an existing read-only collector.

The native Schedule owns cadence, delivery, retries and cancellation. This
adapter only samples, records evidence and decides whether AI review is useful.
"""
import argparse
import importlib.util
import json
import os
import time
from pathlib import Path
from urllib.request import urlopen


def atomic_json(path, value):
    temp = path.with_name(path.name + f'.{os.getpid()}.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temp.replace(path)


def condition(snapshot):
    if snapshot['status'] != 'ok':
        return {'faults': ['observation_failed'], 'topology': None}
    devices = snapshot['capacity']['devices']
    if not devices:
        raise ValueError('capacity has no registered devices')
    return {
        'faults': sorted(f"{d['key']}:{d.get('reason', 'unavailable')}"
                         for d in devices if not d['ready']),
        'topology': sorted((d['key'], d['host'], str(d['gpu']), d['configured'])
                           for d in devices),
    }


def decide(previous, current, now, review_seconds):
    old = previous.get('condition') if previous else None
    # JSON round-trip keeps tuples/lists identical after persisted reloads.
    current = json.loads(json.dumps(current))
    reason = ''
    if current['faults'] != (old or {}).get('faults', []):
        reason = 'new_anomaly' if current['faults'] else 'recovered'
    elif old and current['topology'] != old['topology']:
        reason = 'capacity_configuration_changed'
    elif not previous or now - previous['lastReviewAt'] >= review_seconds:
        reason = 'periodic_review'
    last_review = now if reason else previous['lastReviewAt']
    sequence = (previous or {}).get('sequence', 0) + bool(reason)
    return ({'trigger': bool(reason), 'reason': reason or 'unchanged_or_normal_load',
             'dedupeKey': f'capacity-review:{sequence}' if reason else ''},
            {'condition': current, 'lastReviewAt': last_review, 'sequence': sequence})


def check(collector, state_dir, fetch, review_seconds=14400, baseline=False, now=None):
    state_dir = Path(state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    state_path = state_dir / 'review-state.json'
    previous = json.loads(state_path.read_text()) if state_path.exists() else None
    now = time.time() if now is None else now
    try:
        collector.observe(state_dir, fetch)
        snapshot = json.loads((state_dir / 'latest.json').read_text())
        current = condition(snapshot)
    except Exception as error:
        # The error is evidence, not a zero-capacity or healthy sample. Catching
        # here lets the native gate admit diagnosis; unexpected adapter failures
        # still exit nonzero and use the Schedule's gate_error alert.
        snapshot = {'at': now, 'status': 'error',
                    'error': f'{type(error).__name__}: {error}'}
        current = {'faults': ['observation_failed'], 'topology': None}
    if baseline:
        if previous:
            raise ValueError('baseline already exists; preserve review history')
        if current['faults']:
            raise ValueError('unhealthy baseline; leave the next check to admit review')
        previous = {'condition': json.loads(json.dumps(current)),
                    'lastReviewAt': now, 'sequence': 0}
    decision, state = decide(previous, current, now, review_seconds)
    old_snapshot = previous.get('snapshot') if previous else None
    last_review = previous.get('reviewEvidence') if previous else None
    if decision['trigger']:
        reviews = state_dir / 'reviews'
        reviews.mkdir(exist_ok=True)
        last_review = str(reviews / f"{state['sequence']:08d}.json")
        atomic_json(Path(last_review), {'checkedAt': now, 'decision': decision,
                                       'current': snapshot, 'previous': old_snapshot})
    evidence = {'checkedAt': now, 'decision': decision, 'current': snapshot,
                'previous': old_snapshot, 'condition': current,
                'reviewEvidence': last_review}
    atomic_json(state_dir / 'review-latest.json', evidence)
    atomic_json(state_path, {**state, 'snapshot': snapshot, 'reviewEvidence': last_review})
    return {**decision, 'snapshot': str(state_dir / 'review-latest.json')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--collector', required=True)
    parser.add_argument('--state-dir', required=True)
    parser.add_argument('--api', default='http://127.0.0.1:8878')
    parser.add_argument('--review-seconds', type=int, default=14400)
    parser.add_argument('--baseline', action='store_true')
    args = parser.parse_args()
    if args.review_seconds <= 0:
        parser.error('--review-seconds must be positive')
    spec = importlib.util.spec_from_file_location('capacity_collector', args.collector)
    collector = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(collector)

    def fetch():
        with urlopen(args.api.rstrip('/') + '/healthz', timeout=15) as response:
            return json.load(response)

    print(json.dumps(check(collector, args.state_dir, fetch, args.review_seconds,
                           args.baseline), ensure_ascii=False))


if __name__ == '__main__':
    main()
