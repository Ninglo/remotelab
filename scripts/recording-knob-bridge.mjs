#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { RecordingKnobTransport } from '../lib/recording/knob-transport.mjs';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) options[args[i].replace(/^--/, '')] = args[i + 1];
for (const key of ['serial', 'usb-helper', 'ble-helper', 'bluetooth']) {
  if (!options[key]) throw Error(`Missing --${key}`);
}
const bridge = new RecordingKnobTransport({ serial: options.serial, usbHelper: options['usb-helper'],
  bleHelper: options['ble-helper'], bluetooth: options.bluetooth }, event => console.log(JSON.stringify(event)));
bridge.start();
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  try { bridge.command(JSON.parse(line)); }
  catch (error) { console.log(JSON.stringify({ error: error.message })); }
});
input.once('close', () => bridge.close());
process.once('SIGTERM', () => { input.close(); bridge.close(); });
process.once('SIGINT', () => { input.close(); bridge.close(); });
