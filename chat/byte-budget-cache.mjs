// Estimated retained bytes, not a V8 heap-size promise. Limits are independent
// of history length; oversized values remain readable without flushing hot data.
export class ByteBudgetCache {
  #entries = new Map();
  #bytes = 0;
  constructor(maxBytes, sizeOf) { this.maxBytes = maxBytes; this.sizeOf = sizeOf; }
  get size() { return this.#entries.size; }
  get bytes() { return this.#bytes; }
  has(key) { return this.#entries.has(key); }
  peek(key) { return this.#entries.get(key)?.value; }
  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key); this.#entries.set(key, entry);
    entry.at = Date.now();
    return entry.value;
  }
  set(key, value) {
    this.delete(key);
    const bytes = this.sizeOf(value) + String(key).length * 2 + 96;
    if (bytes > this.maxBytes) return this;
    this.#entries.set(key, { value, bytes, at: Date.now() }); this.#bytes += bytes;
    while (this.#bytes > this.maxBytes) this.delete(this.#entries.keys().next().value);
    return this;
  }
  delete(key) {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    this.#bytes -= entry.bytes;
    return this.#entries.delete(key);
  }
  clear() { this.#entries.clear(); this.#bytes = 0; }
  // Release entries nobody has read or written recently. Map order is LRU, so
  // the sweep stops at the first entry still inside the idle window.
  sweepIdle(maxIdleMs, now = Date.now()) {
    let released = 0;
    for (const [key, entry] of this.#entries) {
      if (now - entry.at < maxIdleMs) break;
      this.delete(key); released += 1;
    }
    return released;
  }
  keys() { return this.#entries.keys(); }
  *values() { for (const entry of this.#entries.values()) yield entry.value; }
  *[Symbol.iterator]() { for (const [key, entry] of this.#entries) yield [key, entry.value]; }
}

export function cacheBudgetBytes(envName, defaultMiB) {
  const configured = process.env[envName];
  const value = configured === undefined || configured === '' ? defaultMiB : Number(configured);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${envName} must be a nonnegative MiB value`);
  return Math.floor(value * 1024 * 1024);
}
