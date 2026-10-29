import { SAMPLE_RATE } from './config.mjs';

// Compare both microphones in fixed 20 ms windows. An occupied microphone is
// still a reference: its speech leaking into the free mic must not claim it.
export class AutoChannelSelector {
  constructor(options) {
    this.options = options;
    this.square = [0, 0]; this.frames = 0;
    this.candidate = null; this.confirmedFrames = 0;
    this.levelsDb = [-120, -120];
  }
  accept(channels, available) {
    const windowFrames = SAMPLE_RATE / 50;
    for (let offset = 0; offset < channels[0].length; offset += 2) {
      for (let ch = 0; ch < 2; ch++) this.square[ch] += (channels[ch].readInt16LE(offset) / 32768) ** 2;
      if (++this.frames < windowFrames) continue;
      const db = this.square.map(value => value ? 10 * Math.log10(value / this.frames) : -120);
      this.levelsDb = db;
      const winner = db[0] > db[1] ? 0 : 1;
      const clear = available.includes(winner) && db[winner] >= this.options.minDb
        && db[winner] - db[1 - winner] >= this.options.marginDb;
      if (!clear || this.candidate !== winner) this.confirmedFrames = 0;
      this.candidate = clear ? winner : null;
      if (clear) this.confirmedFrames += this.frames;
      this.square = [0, 0]; this.frames = 0;
      if (this.confirmedFrames >= this.options.confirmMs * SAMPLE_RATE / 1000) return winner;
    }
    return null;
  }
}
