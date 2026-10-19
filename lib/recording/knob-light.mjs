// The recorder owns audio and cues. This projection only drives the selected knob.
const colors = { blue: [100, 160, 255], coral: [255, 80, 70], white: [255, 210, 160] };
const off = () => ({ rgb: colors.blue, brightness: 0, enabled: false });
const light = (rgb, brightness) => ({ rgb, brightness: Math.round(brightness), enabled: true });

export class RecordingKnobLight {
  constructor(laneId) { this.laneId = laneId; this.reset(); }
  reset() { this.initial = true; this.activeId = null; this.phase = 'offline'; this.since = 0; this.flashUntil = 0; }
  update(status, now) {
    if (!Array.isArray(status?.active) || !Array.isArray(status?.records)) { this.reset(); return; }
    const active = status.active.find(row => row.laneId === this.laneId);
    if (active) {
      if (active.recordingId !== this.activeId) {
        this.activeId = active.recordingId;
        this.flashUntil = this.initial ? 0 : now + 250;
        this.since = now;
      }
      const phase = active.state === 'recording' ? 'recording' : 'starting';
      if (phase !== this.phase) this.since = now;
      this.phase = phase;
    } else if (this.activeId) {
      const saved = status.records.find(row => row.id === this.activeId && row.laneId === this.laneId);
      const success = saved?.endedAt && !saved.interrupted && !saved.error
        && ['held', 'pending', 'blocked', 'submitted'].includes(saved.status);
      this.phase = success ? 'ending' : 'error'; this.since = now; this.activeId = null;
    } else if (this.initial) this.phase = 'idle';
    this.initial = false;
  }
  frame(now) {
    const elapsed = Math.max(0, now - this.since);
    if (this.phase === 'starting' || (this.phase === 'recording' && now < this.flashUntil)) return light(colors.coral, 30);
    if (this.phase === 'recording') return light(colors.blue, 25 - 10 * Math.cos(2 * Math.PI * elapsed / 4000));
    if (this.phase === 'ending') {
      if (elapsed < 250 || (elapsed >= 450 && elapsed < 700)) return light(colors.white, 35);
      if (elapsed < 450) return light(colors.white, 8);
      if (elapsed < 1700) return light(colors.white, 35 * (1 - (elapsed - 700) / 1000));
      this.phase = 'idle';
    }
    if (this.phase === 'error') {
      if (elapsed < 3000) return light(colors.coral, Math.floor(elapsed / 250) % 2 ? 5 : 45);
      this.phase = 'idle';
    }
    return off();
  }
}

export function knobStatusSignature(status) {
  return JSON.stringify({ pid: status.pid, active: status.active,
    records: status.records?.map(({ id, status, endedAt, interrupted, error }) => ({ id, status, endedAt, interrupted, error })) });
}
