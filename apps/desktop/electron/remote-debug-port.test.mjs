import { describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { portIsFree, resolveRemoteDebugPort } from "./remote-debug-port.mjs";

const neverProbed = async () => {
  throw new Error("A packaged app must not look for a port it was not asked to open.");
};

describe("packaged app", () => {
  for (const requested of [undefined, "", "  ", "0", "not-a-port", "-1"]) {
    it(`stays closed when the launch asks for ${JSON.stringify(requested)}`, async () => {
      assert.equal(await resolveRemoteDebugPort({ packaged: true, requested, isFree: neverProbed }), 0);
    });
  }

  it("opens the exact port a launch asks for", async () => {
    assert.equal(await resolveRemoteDebugPort({ packaged: true, requested: " 9223 ", isFree: neverProbed }), 9223);
  });
});

describe("development", () => {
  it("picks the first free port by default", async () => {
    const free = new Set([9225, 9226]);
    assert.equal(await resolveRemoteDebugPort({ packaged: false, isFree: async (port) => free.has(port) }), 9225);
  });

  it("treats 0 as any free port, as worktree runs rely on", async () => {
    assert.equal(await resolveRemoteDebugPort({ packaged: false, requested: "0", isFree: async () => true }), 9223);
  });

  it("uses the exact port asked for without probing", async () => {
    assert.equal(await resolveRemoteDebugPort({ packaged: false, requested: "9823", isFree: neverProbed }), 9823);
  });

  it("stays closed when every candidate is taken", async () => {
    assert.equal(await resolveRemoteDebugPort({ packaged: false, isFree: async () => false }), 0);
  });

  it("sees a port another process really holds", async () => {
    const held = net.createServer();
    await new Promise((resolve) => held.listen({ port: 0, host: "127.0.0.1" }, resolve));
    const { port } = held.address();
    assert.equal(await portIsFree(port), false);
    await new Promise((resolve) => held.close(resolve));
    assert.equal(await portIsFree(port), true);
  });
});
