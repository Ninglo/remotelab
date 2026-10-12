// Envelope and levels derived from exactly the mono PCM successfully appended to disk.
export function pcmMeter(data) {
  const count = Math.floor(data.length / 2), bins = Math.min(64, count);
  let peak = 0, square = 0;
  const waveform = Array(bins).fill(0);
  for (let i = 0; i < count; i++) {
    const value = data.readInt16LE(i * 2) / 32768, magnitude = Math.abs(value);
    peak = Math.max(peak, magnitude); square += value * value;
    const bin = Math.floor(i * bins / count);
    waveform[bin] = Math.max(waveform[bin], magnitude);
  }
  const rms = count ? Math.sqrt(square / count) : 0;
  return { peak, rms, peakDb: peak ? 20 * Math.log10(peak) : -96, rmsDb: rms ? 20 * Math.log10(rms) : -96, waveform };
}
