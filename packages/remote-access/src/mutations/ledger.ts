import { createHash } from "node:crypto";
import {
  BridgeError,
  PreflightError,
  type MutationReceipt,
} from "../contract/index.js";
import { Store } from "../storage/store.js";
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v !== null && typeof v === "object")
    return (
      "{" +
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => JSON.stringify(k) + ":" + canonical(x))
        .join(",") +
      "}"
    );
  return JSON.stringify(v) ?? "null";
}
export class Ledger {
  constructor(
    private store: Store,
    private now: () => number = Date.now,
  ) {}
  async perform(
    deviceId: string,
    requestId: string,
    route: string,
    body: unknown,
    forward: () => Promise<string | null>,
  ): Promise<MutationReceipt> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        requestId,
      )
    )
      throw new BridgeError("INVALID_REQUEST", 400);
    const hash = createHash("sha256")
        .update(canonical({ route, body }))
        .digest("hex"),
      key = deviceId + ":" + requestId,
      time = new Date(this.now()).toISOString();
    const claim = await this.store.update((s) => {
      const previous = s.ledger[key];
      if (previous) {
        if (previous.hash !== hash)
          throw new BridgeError("REQUEST_CONFLICT", 409);
        return { fresh: false, receipt: previous.receipt };
      }
      const records = Object.entries(s.ledger).filter(
        ([, r]) => r.deviceId === deviceId,
      );
      for (const [k, r] of records)
        if (
          this.now() - Date.parse(r.createdAt) > 30 * 86400000 &&
          r.receipt.state !== "pending"
        )
          delete s.ledger[k];
      if (
        Object.values(s.ledger).filter((r) => r.deviceId === deviceId).length >=
        10000
      )
        throw new BridgeError("LEDGER_FULL", 429);
      const receipt: MutationReceipt = {
        requestId,
        resourceId: null,
        state: "pending",
        observedAt: time,
      };
      s.ledger[key] = { deviceId, hash, route, createdAt: time, receipt };
      return { fresh: true, receipt };
    });
    if (!claim.fresh) return claim.receipt;
    let receipt: MutationReceipt;
    try {
      const resourceId = await forward();
      receipt = {
        requestId,
        resourceId,
        state: "accepted",
        observedAt: new Date(this.now()).toISOString(),
      };
    } catch (error) {
      if (error instanceof PreflightError) {
        await this.store.update((s) => {
          s.ledger[key]!.receipt = {
            requestId,
            resourceId: null,
            state: "rejected",
            observedAt: new Date(this.now()).toISOString(),
          };
        });
        throw error;
      }
      receipt = {
        requestId,
        resourceId: null,
        state: "outcome_unknown",
        observedAt: new Date(this.now()).toISOString(),
      };
    }
    try {
      await this.store.update((s) => {
        s.ledger[key]!.receipt = receipt;
      });
    } catch {
      return { ...receipt, state: "outcome_unknown" };
    }
    return receipt;
  }
}
