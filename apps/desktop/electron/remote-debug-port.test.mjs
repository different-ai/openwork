import { describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { pickRemoteDebugPort, portIsFree, remoteDebugMenuItems, remoteDebugRelaunchArgs, resolveRemoteDebugPort } from "./remote-debug-port.mjs";

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

describe("restarting for debugging from the Help menu", () => {
  it("offers to turn debugging on in a packaged app that has no port open", () => {
    const asked = [];
    const items = remoteDebugMenuItems({ packaged: true, port: 0, restart: (debugging) => asked.push(debugging) });
    assert.deepEqual(items.map((item) => item.label ?? item.type), ["separator", "Restart with Debugging..."]);
    items[1].click();
    assert.deepEqual(asked, [true]);
  });

  it("shows the open port and offers to turn debugging off", () => {
    const asked = [];
    const items = remoteDebugMenuItems({ packaged: true, port: 9224, restart: (debugging) => asked.push(debugging) });
    assert.deepEqual(items.map((item) => item.label ?? item.type), ["separator", "Debugging Is On (Port 9224)", "Restart without Debugging"]);
    assert.equal(items[1].enabled, false);
    items[2].click();
    assert.deepEqual(asked, [false]);
  });

  it("adds nothing to a development run, which always has a port", () => {
    assert.deepEqual(remoteDebugMenuItems({ packaged: false, port: 9223, restart: () => {} }), []);
  });

  it("restarts on the first free port, or the first one when none is free", async () => {
    assert.equal(await pickRemoteDebugPort(async (port) => port === 9225), 9225);
    assert.equal(await pickRemoteDebugPort(async () => false), 9223);
  });

  it("passes the port as the launch switch and keeps the other arguments", () => {
    assert.deepEqual(remoteDebugRelaunchArgs(["--no-sandbox", "openwork://chat"], 9223), ["--no-sandbox", "openwork://chat", "--remote-debugging-port=9223"]);
  });

  it("replaces an earlier debugging switch instead of adding a second", () => {
    assert.deepEqual(remoteDebugRelaunchArgs(["--remote-debugging-port=9223", "--remote-debugging-address=127.0.0.1", "--no-sandbox"], 9226), ["--no-sandbox", "--remote-debugging-port=9226"]);
  });

  it("removes the switch when restarting without debugging", () => {
    assert.deepEqual(remoteDebugRelaunchArgs(["--no-sandbox", "--remote-debugging-port=9223"], 0), ["--no-sandbox"]);
  });

  it("opens the port the restart asked for", async () => {
    // main.mjs passes the switch value as the request when the variable is unset.
    assert.equal(await resolveRemoteDebugPort({ packaged: true, requested: "9226", isFree: neverProbed }), 9226);
  });
});
