import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { BridgeError } from "../contract/index.js";
import { Store, type Device } from "../storage/store.js";
const secret = () => randomBytes(32).toString("base64url");
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const equal = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
interface Claim {
  id: string;
  pollHash: string;
  deviceId: string;
  name: string;
  expires: number;
  lastPoll: number;
  state: "pending" | "approved" | "denied";
  credential?: string;
  credentialHash?: string;
  deviceRecordId?: string;
  ackExpires?: number;
}
export class Pairing {
  private window?: { id: string; hash: string; expires: number };
  private claims = new Map<string, Claim>();
  private attempts = new Map<string, { count: number; since: number }>();
  constructor(
    private store: Store,
    private now: () => number = Date.now,
    private onRevoke: (id: string) => void = () => {},
  ) {}
  start(origin: string) {
    const u = new URL(origin);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.pathname !== "/" ||
      u.search ||
      u.hash
    )
      throw new BridgeError("INVALID_ORIGIN", 400);
    const s = secret(),
      id = randomUUID();
    this.window = { id, hash: hash(s), expires: this.now() + 300000 };
    return { protocolVersion: 1, origin: u.origin, pairingId: id, secret: s };
  }
  claim(
    value: {
      pairingId: string;
      secret: string;
      deviceId: string;
      deviceName: string;
      protocolVersion: number;
    },
    source: string,
  ) {
    const t = this.now(),
      a = this.attempts.get(source);
    if (a && t - a.since < 60000) {
      if (a.count >= 5) throw new BridgeError("RATE_LIMITED", 429);
      a.count++;
    } else {
      if (this.attempts.size >= 1000) this.attempts.clear();
      this.attempts.set(source, { count: 1, since: t });
    }
    const w = this.window;
    if (
      !w ||
      value.protocolVersion !== 1 ||
      w.id !== value.pairingId ||
      t >= w.expires ||
      typeof value.secret !== "string" ||
      !equal(w.hash, hash(value.secret))
    )
      throw new BridgeError("PAIRING_INVALID", 400);
    if (
      typeof value.deviceId !== "string" ||
      !value.deviceId ||
      value.deviceId.length > 200 ||
      typeof value.deviceName !== "string" ||
      !value.deviceName.trim() ||
      value.deviceName.length > 100
    )
      throw new BridgeError("INVALID_REQUEST", 400);
    this.window = undefined;
    for (const [id, c] of this.claims)
      if (t > c.expires) this.claims.delete(id);
    if (this.claims.size >= 100) throw new BridgeError("RATE_LIMITED", 429);
    const id = randomUUID(),
      pollToken = secret();
    this.claims.set(id, {
      id,
      pollHash: hash(pollToken),
      deviceId: value.deviceId,
      name: value.deviceName,
      expires: w.expires,
      lastPoll: -Infinity,
      state: "pending",
    });
    return {
      claimId: id,
      pollToken,
      expiresAt: new Date(w.expires).toISOString(),
    };
  }
  pending() {
    return [...this.claims.values()]
      .filter((c) => c.state === "pending" && this.now() < c.expires)
      .map((c) => ({
        id: c.id,
        deviceName: c.name,
        expiresAt: new Date(c.expires).toISOString(),
      }));
  }
  poll(id: string, token: string) {
    const c = this.claims.get(id),
      t = this.now();
    if (!c || typeof token !== "string" || !equal(c.pollHash, hash(token)))
      throw new BridgeError("PAIRING_INVALID", 400);
    if (t >= c.expires || (c.ackExpires !== undefined && t >= c.ackExpires)) {
      c.credential = undefined;
      return { state: "expired" as const };
    }
    if (t - c.lastPoll < 2000) throw new BridgeError("RATE_LIMITED", 429);
    c.lastPoll = t;
    if (c.state === "approved" && c.credential) {
      const credential = c.credential;
      c.credential = undefined;
      return {
        state: "approved" as const,
        credential,
        allowedWorkspaces:
          this.store.snapshot.devices.find((d) => d.id === c.deviceRecordId)
            ?.workspaceIds ?? [],
      };
    }
    return { state: c.state };
  }
  async approve(id: string, workspaceIds: string[], allWorkspaces = false) {
    const c = this.claims.get(id);
    if (!c || this.now() >= c.expires)
      throw new BridgeError("PAIRING_EXPIRED", 409);
    if (
      c.state !== "pending" ||
      (!allWorkspaces && !workspaceIds.length) ||
      workspaceIds.length > 100 ||
      workspaceIds.some((w) => !/^[A-Za-z0-9_-]{1,200}$/.test(w))
    )
      throw new BridgeError("INVALID_REQUEST", 400);
    c.state = "approved";
    const token = secret(),
      tokenHash = hash(token),
      recordId = randomUUID();
    try {
      await this.store.update((s) =>
        s.devices.push({
          id: recordId,
          deviceId: c.deviceId,
          name: c.name,
          tokenHash,
          workspaceIds: [...new Set(workspaceIds)],
          allWorkspaces,
          active: false,
          revoked: false,
        }),
      );
      c.credential = token;
      c.credentialHash = tokenHash;
      c.deviceRecordId = recordId;
      c.ackExpires = this.now() + 60000;
    } catch (e) {
      c.state = "denied";
      throw e;
    }
  }
  deny(id: string) {
    const c = this.claims.get(id);
    if (!c || c.state !== "pending")
      throw new BridgeError("PAIRING_INVALID", 409);
    c.state = "denied";
  }
  async ack(token: string) {
    const h = hash(token),
      c = [...this.claims.values()].find((c) => c.credentialHash === h);
    if (
      !c ||
      !c.deviceRecordId ||
      this.now() >= Math.min(c.ackExpires ?? 0, c.expires)
    )
      throw new BridgeError("UNAUTHORIZED", 401);
    await this.store.update((s) => {
      const d = s.devices.find((d) => d.id === c.deviceRecordId);
      if (!d || d.revoked) throw new BridgeError("UNAUTHORIZED", 401);
      d.active = true;
    });
    this.claims.delete(c.id);
  }
  authenticate(token: string): Device {
    if (typeof token !== "string" || token.length > 256)
      throw new BridgeError("UNAUTHORIZED", 401);
    const h = hash(token);
    const d = this.store.snapshot.devices.find((d) => equal(d.tokenHash, h));
    if (!d || !d.active || d.revoked)
      throw new BridgeError("UNAUTHORIZED", 401);
    return d;
  }
  async revoke(id: string) {
    await this.store.update((s) => {
      const d = s.devices.find((d) => d.id === id);
      if (!d) throw new BridgeError("NOT_FOUND", 404);
      d.revoked = true;
    });
    this.onRevoke(id);
  }
  close() {
    this.window = undefined;
    this.claims.clear();
    this.attempts.clear();
  }
}
