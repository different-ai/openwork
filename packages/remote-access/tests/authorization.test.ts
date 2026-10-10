import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeError } from "../src/contract/index.js";
import { Store } from "../src/storage/store.js";
import { Pairing } from "../src/auth/pairing.js";
import { createHash } from "node:crypto";
const api = (await import("../src/server.js").catch(() => ({}))) as any;
test("remote routes enforce device/workspace/session scope; admin actions reject hostile origins", async () => {
  expect(api.createServers).toBeTypeOf("function");
  const parent = await mkdtemp(join(tmpdir(), "owr-routes-"));
  const store = await Store.open(join(parent, "state"));
  const token = "synthetic-device-token";
  await store.update((s) => {
    s.devices.push({
      id: "device",
      deviceId: "phone",
      name: "Phone",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      workspaceIds: ["ws_one"],
      active: true,
      revoked: false,
    });
  });
  let sessionReads = 0;
  const adapter = {
    version: "0.18.57",
    compatibility: "supported",
    capabilities: {
      readSessions: true,
      readMessages: true,
      readStatus: true,
      events: true,
      createSession: true,
      sendText: true,
      stop: true,
      readApprovals: true,
      replyApproval: false,
      maxPromptBytes: 32768,
      protocolVersion: 1,
    },
    health: async () => {},
    listWorkspaces: async () => [
      { id: "ws_one", name: "One" },
      { id: "ws_two", name: "Private" },
    ],
    readSession: async (w: string, s: string) => {
      sessionReads++;
      if (s !== "ses_owned") throw new BridgeError("NOT_FOUND", 404);
      return { id: s, workspaceId: w, title: "Owned" };
    },
    readMessages: async () => ({ data: [], cursor: null }),
  };
  const apps = api.createServers({
    store,
    pairing: new Pairing(store),
    adapter,
    platform: "macos",
    architecture: "arm64",
    origin: "https://host.test:9443",
  });
  try {
    expect((await apps.remote.inject({ url: "/v1/host" })).statusCode).toBe(
      401,
    );
    const headers = { authorization: "Bearer " + token };
    const ws = await apps.remote.inject({ url: "/v1/workspaces", headers });
    expect(ws.json().data).toEqual([{ id: "ws_one", name: "One" }]);
    expect(
      (
        await apps.remote.inject({
          url: "/v1/workspaces/ws_two/sessions/ses_owned/messages",
          headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(sessionReads).toBe(0);
    expect(
      (
        await apps.remote.inject({
          url: "/v1/workspaces/ws_one/sessions/ses_wrong/messages",
          headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await apps.remote.inject({ url: "/admin/pairings", headers }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await apps.admin.inject({
          method: "POST",
          url: "/admin/pairings",
          headers: { host: "127.0.0.1:9289", origin: "https://evil.test" },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await apps.remote.inject({
          url: "/v1/workspaces",
          headers: { ...headers, origin: "https://evil.test" },
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await apps.remote.close();
    await apps.admin.close();
    await store.close();
    await rm(parent, { recursive: true, force: true });
  }
});
