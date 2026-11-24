import { randomBytes } from "node:crypto";

// Continue revokes both issued tickets and viewer requests still awaiting I/O.
// Serialize takeover/resume so a delayed takeover cannot undo Continue.
export class ViewerTickets {
  #tickets = new Map();
  #generation = 0;
  #pending = Promise.resolve();
  constructor(clock = Date.now) { this.clock = clock; }
  get generation() { return this.#generation; }
  assertCurrent(generation) {
    if (generation !== this.#generation) throw Object.assign(new Error("Viewer access changed. Refresh the computer view."), { code: "viewer_revoked" });
  }
  revoke() { this.#generation++; this.#tickets.clear(); return this.#generation; }
  run(generation, action) {
    const result = this.#pending.then(async () => {
      this.assertCurrent(generation);
      const value = await action();
      this.assertCurrent(generation);
      return value;
    });
    this.#pending = result.catch(() => {});
    return result;
  }
  issue(value, generation) {
    this.assertCurrent(generation);
    const now = this.clock();
    for (const [key, ticket] of this.#tickets) if (ticket.expiresAt <= now) this.#tickets.delete(key);
    if (this.#tickets.size >= 16) throw Object.assign(new Error("Close an existing viewer before opening another."), { code: "too_many_viewers" });
    const token = randomBytes(32).toString("base64url");
    this.#tickets.set(token, { ...value, generation, expiresAt: now + 15_000 });
    return token;
  }
  consume(token, origin) {
    const ticket = this.#tickets.get(token);
    this.#tickets.delete(token);
    return ticket && ticket.generation === this.#generation && ticket.expiresAt > this.clock() && ticket.origin === origin ? ticket : null;
  }
}
