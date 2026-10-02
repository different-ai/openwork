import { randomUUID } from "node:crypto";
import { startSessionPow, type SessionPowJob } from "@openwork/free-auto/node";
import type { SessionPowParams } from "@openwork/free-auto";

// Bun (the test runner) cannot terminate inline workers reliably; the app itself runs on Node inside Electron.
const IN_WORKER = typeof process.versions.bun !== "string";

/**
 * Keeps one solved (or solving) proof of work ready for the next guest
 * session, so minting never waits on it after the first launch.
 */
export class SessionPowPool {
  private job: SessionPowJob | null = null;
  constructor(private readonly inWorker = IN_WORKER) {}
  /** Has (or starts) work for `params`; returns the nonce it is bound to. */
  warm(machineId: string, params: SessionPowParams): { nonce: string; ready: Promise<void> } {
    if (!this.job || this.job.bits < params.bits || this.job.rounds !== params.rounds) {
      this.job?.cancel();
      this.job = startSessionPow({ machineId, nonce: randomUUID(), ...params }, this.inWorker);
    }
    const job = this.job;
    return { nonce: job.nonce, ready: job.promise.then(() => undefined) };
  }
  /** Hands over the warmed job if it fits, else starts one; either way the pool is empty afterwards. */
  take(machineId: string, params: SessionPowParams): SessionPowJob {
    const job = this.job && this.job.bits >= params.bits && this.job.rounds === params.rounds
      ? this.job : startSessionPow({ machineId, nonce: randomUUID(), ...params }, this.inWorker);
    if (this.job === job) this.job = null;
    return job;
  }
  cancel(): void { this.job?.cancel(); this.job = null; }
}
