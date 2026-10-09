// Optional Free3 USB indicator. Opening this controller never starts audio.
export function free3LightCommand(key, recording, shift) {
  if (![1, 2, 3].includes(key)) throw Error('Free3 key must be 1, 2 or 3');
  if (shift !== undefined && !['P', 'M', 'R'].includes(shift)) throw Error('Free3 shift must match P, M or R');
  return { o: 'set', k: key, m: 'light', ...(shift ? { s: shift } : {}), v: recording
    ? { enable: true, rgb: '255,0,0', bri: 70 } : { enable: false } };
}

export function selectFree3Port(ports, serial) {
  if (!serial) throw Error('An explicit Free3 USB serial is required');
  const matches = ports.filter((port) => port.vendorId?.toLowerCase() === '4c4a'
    && port.productId?.toLowerCase() === '4155' && port.serialNumber === serial);
  const paths = [...new Set(matches.map((port) => port.path))];
  if (paths.length !== 1) throw Error(`Expected one Free3 USB port for ${serial}; found ${paths.length}. Connect its USB data cable.`);
  return paths[0];
}

export function indicatorSignature(status) {
  return JSON.stringify({ pid: status.pid, active: status.active });
}

export function free3UsbPackets(command, sequence = 1) {
  const data = Buffer.from(JSON.stringify(command));
  if (data.length <= 64) return [data];
  const count = Math.ceil(data.length / 55);
  return Array.from({ length: count }, (_, i) => Buffer.concat([
    Buffer.from(`S${sequence}[${i + 1}/${count}]`), data.subarray(i * 55, (i + 1) * 55),
  ]));
}

// Serializes reads and writes; an old delayed write cannot overtake a stop.
export class Free3RecordingLight {
  constructor({ laneId, key, shift, getStatus, send, report = () => {} }) {
    free3LightCommand(key, false, shift);
    this.laneId = laneId; this.key = key; this.shift = shift; this.getStatus = getStatus;
    this.send = send; this.report = report; this.last = undefined;
    this.queue = Promise.resolve(); this.closed = false;
  }
  refresh() {
    return this.enqueue(async () => {
      if (this.closed) return;
      let recording = false, error = '';
      try {
        const status = await this.getStatus();
        if (!Array.isArray(status.active)) throw Error('Invalid live recording status');
        recording = status.active.some((lane) => lane.laneId === this.laneId && lane.state === 'recording');
      } catch (e) { error = e.message; }
      if (recording !== this.last) {
        await this.send(free3LightCommand(this.key, recording, this.shift));
        this.last = recording;
        this.report({ recording, ...(error ? { error } : {}) });
      }
    });
  }
  enqueue(action) {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }
  close() {
    this.closed = true;
    return this.enqueue(async () => {
      await this.send(free3LightCommand(this.key, false, this.shift));
      this.last = false;
    });
  }
}
