// Test-only clock. SQL uses its normal connection and server clock.
export function installClock(initialTime) {
  const NativeDate = globalThis.Date;
  let now = initialTime;
  class ClockDate extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() { return now; }
  }
  globalThis.Date = ClockDate;
  return {
    now: () => now,
    set(value) {
      if (!Number.isFinite(value) || value < now) throw new Error("Test clock must not move back.");
      now = value;
    },
    restore() { globalThis.Date = NativeDate; },
  };
}
