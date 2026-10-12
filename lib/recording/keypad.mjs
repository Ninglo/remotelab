// Chords require overlapping down states received within 250 ms on one device/page.
// Releases and disconnects are essential: sequential taps must never mean stop.
export class RecordingKeypad {
  constructor(bindings, now = () => performance.now(), isRecording = () => false) {
    this.bindings = bindings; this.now = now; this.isRecording = isRecording; this.groups = new Map(); this.protectedUntil = new Map();
  }
  reset(deviceId) {
    for (const [id, group] of this.groups) if (!deviceId || group.deviceId === deviceId) this.groups.delete(id);
  }
  accept(event) {
    if (event.disconnected || event.error) { this.reset(event.deviceId); return; }
    const page = event.usagePage ?? 7;
    const bindings = this.bindings.filter((b) => b.deviceId === event.deviceId && (b.usagePage ?? 7) === page);
    if (!bindings.some((b) => (b.keys || [b.key]).includes(event.key))) return;
    const id = `${event.deviceId}:${page}`;
    let group = this.groups.get(id);
    if (!group) { group = { deviceId: event.deviceId, held: new Map(), latched: false, tap: null }; this.groups.set(id, group); }
    if (!event.pressed) {
      group.held.delete(event.key);
      if (!group.held.size) group.latched = false;
      return;
    }
    if (group.held.has(event.key) || group.latched) return;
    group.held.set(event.key, Number.isFinite(event.timestampMs) ? event.timestampMs : this.now());
    for (const chord of bindings.filter((b) => b.keys)) {
      if (!chord.keys.every((k) => group.held.has(k))) continue;
      const times = chord.keys.map((k) => group.held.get(k));
      if (Math.max(...times) - Math.min(...times) <= 250) { group.latched = true; return chord; }
    }
    // A start key combined with another held key is not an independent start.
    if (group.held.size !== 1) return;
    const single = bindings.find((b) => !b.keys && !b.gesture && b.key === event.key);
    const double = bindings.find((b) => b.gesture === 'double' && b.key === event.key);
    if (!double) {
      if (single?.action === 'start' && !this.isRecording(single.laneId)) this.protectedUntil.set(single.laneId, this.now() + 1000);
      return single;
    }
    if (!this.isRecording(double.laneId)) {
      group.tap = null;
      if (single) this.protectedUntil.set(double.laneId, this.now() + 1000);
      return single;
    }
    if (this.now() < (this.protectedUntil.get(double.laneId) || 0)) { group.tap = null; return; }
    const at = group.held.get(event.key), previous = group.tap;
    group.tap = { key: event.key, at };
    if (previous?.key === event.key && at - previous.at >= 80 && at - previous.at <= 800) {
      group.tap = null; group.latched = true;
      return double;
    }
    // A solitary press during recording is intentionally a no-op.
    return;
  }
}
