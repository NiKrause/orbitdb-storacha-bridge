/**
 * Memory Courier — an in-memory pair of byte couriers for testing courier-sync
 * without any radio, network or filesystem.
 *
 * Implements the seam contract from courier-sync.js and misbehaves on request:
 * messages can be dropped, duplicated and delivered out of order, because a
 * real courier (a LoRa mesh above all) does all three. The GPL-side Meshtastic
 * courier is expected to test its protocol against this same contract.
 *
 * Deliveries are asynchronous (macrotask) so both ends always see the same
 * causality a real courier would give them; `pair.idle()` resolves when no
 * message is in flight on either side.
 */

/**
 * @param {Object} [options]
 * @param {"fifo"|"lifo"} [options.order="fifo"] "lifo" reverses each drained
 *   batch — a deterministic worst case for reordering tolerance.
 * @param {(info: {seq: number, from: "a"|"b", bytes: Uint8Array}) => boolean} [options.dropFn]
 *   Return true to lose that message.
 * @param {(info: {seq: number, from: "a"|"b", bytes: Uint8Array}) => boolean} [options.duplicateFn]
 *   Return true to deliver that message twice.
 * @returns {{a: Object, b: Object, idle: () => Promise<void>, stats: Object}}
 */
export function createMemoryCourierPair(options = {}) {
  const { order = "fifo", dropFn = null, duplicateFn = null } = options;

  const stats = { sent: 0, delivered: 0, dropped: 0, duplicated: 0 };
  let seq = 0;
  let inFlight = 0;
  const idleWaiters = [];

  const settle = () => {
    if (inFlight === 0) {
      while (idleWaiters.length > 0) idleWaiters.shift()();
    }
  };

  const makeEnd = (name) => {
    const listeners = new Set();
    const queue = [];
    let drainScheduled = false;

    const drain = () => {
      drainScheduled = false;
      const batch =
        order === "lifo" ? queue.splice(0).reverse() : queue.splice(0);
      for (const bytes of batch) {
        stats.delivered++;
        for (const cb of listeners) cb(bytes);
        inFlight--;
      }
      settle();
    };

    return {
      listeners,
      deliver(bytes) {
        inFlight++;
        queue.push(bytes);
        if (!drainScheduled) {
          drainScheduled = true;
          setTimeout(drain, 0);
        }
      },
      name,
    };
  };

  const endA = makeEnd("a");
  const endB = makeEnd("b");

  const makeCourier = (from, remote) => ({
    async send(bytes) {
      stats.sent++;
      const info = { seq: seq++, from, bytes };
      if (dropFn && dropFn(info)) {
        stats.dropped++;
        return;
      }
      remote.deliver(bytes);
      if (duplicateFn && duplicateFn(info)) {
        stats.duplicated++;
        remote.deliver(bytes);
      }
    },
    onPayload(cb) {
      const local = from === "a" ? endA : endB;
      local.listeners.add(cb);
      return () => local.listeners.delete(cb);
    },
  });

  return {
    a: makeCourier("a", endB),
    b: makeCourier("b", endA),
    stats,
    idle() {
      return new Promise((resolve) => {
        idleWaiters.push(resolve);
        settle();
      });
    },
  };
}
