// Only one projection can wait for a receipt. Pending changes coalesce to the
// latest snapshot, and a silent transport cannot hold the channel forever.
export function createLatestChannel(send, {
  receiptTimeoutMs = 25000,
  onTimeout = () => {},
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  let pending, inFlight, deadline;
  function clearDeadline() {
    if (deadline !== undefined) cancel(deadline);
    deadline = undefined;
  }
  function pump() {
    if (inFlight || !pending) return;
    const packet = pending;
    pending = undefined;
    inFlight = packet;
    if (send(packet) === false) {
      inFlight = undefined;
      pending = packet;
      return;
    }
    deadline = schedule(() => {
      deadline = undefined;
      if (inFlight !== packet) return;
      inFlight = undefined;
      pending = undefined;
      // The caller reconnects and sends a fresh snapshot; expired state is
      // never replayed, and missing receipts never count as delivery.
      onTimeout(packet);
    }, receiptTimeoutMs);
    deadline?.unref?.();
  }
  return {
    offer(packet) { pending = packet; pump(); },
    ack(serial) {
      if (inFlight?.serial !== serial) return false;
      clearDeadline();
      inFlight = undefined;
      pump();
      return true;
    },
    reset() { clearDeadline(); pending = inFlight = undefined; },
    get activeSerial() { return inFlight?.serial; },
  };
}
