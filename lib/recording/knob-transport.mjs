import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';

const run = promisify(execFile);
const reportTypes = [0, 2, 3, 4, 5, 6];

export function bluetoothKnobReports(output) {
  const reports = new Map();
  for (const line of output.split('\n').filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.type !== 'notify' || event.short_uuid !== 'AE42') continue;
    let bytes = [...Buffer.from(event.data.replace(/\s/g, ''), 'hex')];
    if (bytes[0] === 3 && bytes[1] === 3 && bytes[2] === 253) bytes = bytes.slice(1);
    if (bytes.length === 64 && bytes[0] === 3 && bytes[1] === 253) reports.set(bytes[2], bytes);
  }
  if (!reportTypes.every(type => reports.has(type))) throw Error('Incomplete Bluetooth knob configuration');
  return [...reports.values()];
}

export function bluetoothKnobLight({ rgb, brightness, enabled }) {
  if (!Array.isArray(rgb) || rgb.length !== 3 || !rgb.every(v => Number.isInteger(v) && v >= 0 && v <= 255)
    || !Number.isInteger(brightness) || brightness < 0 || brightness > 100 || typeof enabled !== 'boolean') {
    throw Error('Invalid Bluetooth light settings');
  }
  // ANTICATER AE41 uses the same report prefix as USB, in a 64-byte GATT packet.
  const bytes = Buffer.alloc(64);
  bytes.set([3, 253, 0, 6, ...rgb, brightness, enabled ? 1 : 0]);
  return bytes.toString('hex');
}

/** Preserve the native USB helper protocol while selecting one light transport. */
export class RecordingKnobTransport {
  constructor(options, emit, dependencies = {}) {
    this.options = options;
    this.emit = emit;
    this.spawn = dependencies.spawn || spawn;
    this.run = dependencies.run || run;
    this.epoch = 0;
    this.pending = [];
    this.stopping = false;
  }
  lines(child, receive) {
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try { receive(JSON.parse(line)); }
      catch (error) { this.fail(error); }
    });
    child.once('close', () => lines.close());
  }
  start() {
    this.usb = this.spawn(this.options.usbHelper, ['--serial', this.options.serial], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.usb.stdin.on('error', error => this.fail(error));
    this.usb.once('error', error => this.fail(error));
    this.usb.once('exit', (code, signal) => {
      if (!this.stopping) this.fail(Error(`USB knob helper exited (${code ?? signal})`));
    });
    this.lines(this.usb, event => {
      if (event.event === 'connected') {
        this.usbConnected = true;
        this.cancelBluetooth();
        this.emit({ ...event, transport: 'usb' });
      } else if (event.event === 'disconnected' || event.event === 'usb-absent') {
        this.usbConnected = false;
        this.emit({ event: 'disconnected', transport: 'usb' });
        this.connectBluetooth();
      } else if (this.usbConnected || event.error) this.emit(event);
    });
  }
  fail(error) {
    if (!this.stopping) this.emit({ error: error.message });
  }
  cancelBluetooth() {
    ++this.epoch;
    this.opening = false;
    this.queryAbort?.abort();
    this.queryAbort = null;
    this.bleReady = false;
    const child = this.ble;
    this.ble = null;
    if (child && !child.stdin.destroyed) {
      child.stdin.end(JSON.stringify({ type: 'quit' }) + '\n');
    }
    // Switching transport forces the projection's latest frame to be resent.
    // Complete the old in-flight writes so they cannot fail the new USB session.
    for (const id of this.pending.splice(0)) this.emit({ id, code: 0, superseded: true });
  }
  async connectBluetooth() {
    if (this.stopping || this.usbConnected || this.opening || this.bleReady) return;
    this.opening = true;
    const epoch = ++this.epoch;
    const current = () => epoch === this.epoch && !this.stopping && !this.usbConnected;
    const abort = this.queryAbort = new AbortController();
    try {
      const result = await this.run(this.options.bleHelper,
        ['connect', this.options.bluetooth, '--query', '--listen', '3', '--timeout', '8'],
        { timeout: 30000, maxBuffer: 512 * 1024, signal: abort.signal });
      if (!current()) return;
      this.reports = bluetoothKnobReports(result.stdout);
      this.queryAbort = null;
      const child = this.ble = this.spawn(this.options.bleHelper,
        ['session', this.options.bluetooth, '--timeout', '8'], { stdio: ['pipe', 'pipe', 'inherit'] });
      const failed = error => { if (current()) this.fail(error); };
      child.stdin.on('error', failed);
      child.once('error', failed);
      child.once('exit', (code, signal) => {
        // A cancelled BLE writer may finish one queued packet after USB appears.
        // Resend USB's current state after that writer has fully stopped.
        if (!this.stopping && this.usbConnected) {
          this.emit({ event: 'connected', transport: 'usb', serial: this.options.serial });
        }
        if (!current()) return;
        this.bleReady = false;
        this.emit({ event: 'disconnected', transport: 'bluetooth' });
        failed(Error(`Bluetooth knob session exited (${code ?? signal})`));
      });
      this.lines(child, event => {
        if (!current()) return;
        if (event.type === 'session_ready') {
          if (event.short_uuid !== 'AE41') return failed(Error('Expected ANTICATER AE41 write characteristic'));
          this.opening = false;
          this.bleReady = true;
          this.emit({ event: 'connected', transport: 'bluetooth', peripheral: this.options.bluetooth });
        } else if (event.type === 'write_ok') {
          const id = this.pending.shift();
          if (id !== undefined) this.emit({ id, code: 0 });
        } else if (event.type === 'session_disconnected') {
          this.bleReady = false;
          this.emit({ event: 'disconnected', transport: 'bluetooth' });
          failed(Error('Bluetooth knob disconnected'));
        } else if (event.type === 'error') failed(Error(event.message));
      });
    } catch (error) { if (current()) this.fail(Error(`Bluetooth knob: ${error.message}`)); }
  }
  command(command) {
    if (this.stopping) return;
    if (this.usbConnected) {
      this.usb.stdin.write(JSON.stringify(command) + '\n');
      return;
    }
    try {
      if (!this.bleReady) throw Error('Bluetooth knob is not ready');
      if (command.action === 'query') {
        for (const bytes of this.reports) this.emit({ event: 'report', code: 0, bytes });
        this.emit({ id: command.id, code: 0 });
      } else if (command.action === 'light') {
        const packet = bluetoothKnobLight(command);
        this.pending.push(command.id);
        this.ble.stdin.write(JSON.stringify({ type: 'write', packets: [packet] }) + '\n');
      } else throw Error('Button remapping requires USB; Bluetooth bridge only controls lighting');
    } catch (error) { this.emit({ id: command.id, code: 1, error: error.message }); }
  }
  close() {
    if (this.stopping) return;
    this.stopping = true;
    if (this.bleReady && this.ble && !this.ble.stdin.destroyed) {
      // The official helper processes stdin in order, including EOF. Clear even
      // if the projection died before sending its normal shutdown frame.
      const packet = bluetoothKnobLight({ rgb: [0, 0, 0], brightness: 0, enabled: false });
      this.ble.stdin.write(JSON.stringify({ type: 'write', packets: [packet] }) + '\n');
    }
    this.cancelBluetooth();
    this.usb?.stdin.end();
  }
}
