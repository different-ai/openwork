import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const st = (await import("../src/storage/store.js").catch(() => ({}))) as any;
const api = (await import("../src/auth/pairing.js").catch(() => ({}))) as any;
test("one-time claim requires local approval and ack; replay and revocation fail closed", async () => {
  expect(api.Pairing).toBeTypeOf("function");
  const parent = await mkdtemp(join(tmpdir(), "owr-pair-"));
  let store: any;
  try {
    store = await st.Store.open(join(parent, "data"));
    let now = 1000;
    const p = new api.Pairing(store, () => now);
    const payload = p.start("https://host.test:9443");
    const claim = p.claim(
      {
        ...payload,
        deviceId: "device-test",
        deviceName: "Test phone",
        protocolVersion: 1,
      },
      "source",
    );
    expect(() =>
      p.claim(
        {
          ...payload,
          deviceId: "other",
          deviceName: "Other",
          protocolVersion: 1,
        },
        "source",
      ),
    ).toThrow("PAIRING_INVALID");
    expect(p.poll(claim.claimId, claim.pollToken).state).toBe("pending");
    await p.approve(claim.claimId, ["ws_one"]);
    now += 2001;
    const result = p.poll(claim.claimId, claim.pollToken);
    expect(result.state).toBe("approved");
    expect(() => p.authenticate(result.credential)).toThrow("UNAUTHORIZED");
    await p.ack(result.credential);
    expect(p.authenticate(result.credential).workspaceIds).toEqual(["ws_one"]);
    await p.revoke(p.authenticate(result.credential).id);
    expect(() => p.authenticate(result.credential)).toThrow("UNAUTHORIZED");
    expect(JSON.stringify(store.snapshot)).not.toContain(result.credential);
    expect(JSON.stringify(store.snapshot)).not.toContain(payload.secret);
  } finally {
    await store?.close();
    await rm(parent, { recursive: true, force: true });
  }
});
test("expired pairing and forged poll token cannot reveal a credential", async () => {
  expect(api.Pairing).toBeTypeOf("function");
  const parent = await mkdtemp(join(tmpdir(), "owr-exp-"));
  let store: any;
  try {
    store = await st.Store.open(join(parent, "data"));
    let now = 0;
    const p = new api.Pairing(store, () => now),
      payload = p.start("https://host.test"),
      claim = p.claim(
        {
          ...payload,
          deviceId: "device",
          deviceName: "Phone",
          protocolVersion: 1,
        },
        "source",
      );
    expect(() => p.poll(claim.claimId, "forged")).toThrow("PAIRING_INVALID");
    now = 300001;
    expect(p.poll(claim.claimId, claim.pollToken).state).toBe("expired");
    await expect(p.approve(claim.claimId, ["ws_one"])).rejects.toThrow(
      "PAIRING_EXPIRED",
    );
  } finally {
    await store?.close();
    await rm(parent, { recursive: true, force: true });
  }
});
