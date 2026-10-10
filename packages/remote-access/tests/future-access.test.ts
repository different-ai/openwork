import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../src/storage/store.js";
import { Pairing } from "../src/auth/pairing.js";
import { createServers } from "../src/server.js";
import { ReplayBuffer } from "../src/events/replay-buffer.js";
test("future-project access is an explicit host grant; changes preserve credentials and take effect immediately", async () => {
  const parent = await mkdtemp(join(tmpdir(), "owr-future-")),
    store = await Store.open(join(parent, "state")),
    token = "synthetic-token";
  await store.update((s) =>
    s.devices.push({
      id: "device",
      deviceId: "phone",
      name: "Phone",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      workspaceIds: ["ws_one"],
      active: true,
      revoked: false,
    }),
  );
  let workspaces = [{ id: "ws_one", name: "One" }];
  const adapter: any = {
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
      replyApproval: true,
      maxPromptBytes: 32768,
      protocolVersion: 1,
    },
    listWorkspaces: async () => workspaces,
  };
  const apps = createServers({
    store,
    pairing: new Pairing(store),
    adapter,
    platform: "macos",
    architecture: "arm64",
    origin: "https://host.test",
  });
  try {
    const headers = { authorization: "Bearer " + token };
    workspaces.push({ id: "ws_new", name: "Added later" });
    expect(
      (await apps.remote.inject({ url: "/v1/workspaces", headers })).json()
        .data,
    ).toHaveLength(1);
    const root = await apps.admin.inject({
      url: "/",
      headers: { host: "127.0.0.1:9289" },
    });
    const cookie = String(root.headers["set-cookie"]).split(";")[0];
    const state = await apps.admin.inject({
      url: "/admin/state",
      headers: { host: "127.0.0.1:9289", cookie },
    });
    const csrf = state.json().data.csrf;
    const update = async (allWorkspaces: boolean) =>
      apps.admin.inject({
        method: "POST",
        url: "/admin/devices/device/access",
        headers: {
          host: "127.0.0.1:9289",
          origin: "http://127.0.0.1:9289",
          cookie,
          "x-admin-session": csrf,
        },
        payload: { workspaceIds: ["ws_one"], allWorkspaces },
      });
    expect((await update(true)).statusCode).toBe(200);
    expect(
      (await apps.remote.inject({ url: "/v1/workspaces", headers })).json()
        .data,
    ).toHaveLength(2);
    expect(store.snapshot.devices[0]!.tokenHash).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
    expect(
      (
        await apps.remote.inject({
          method: "POST",
          url: "/v1/device/access",
          headers,
          payload: { allWorkspaces: true },
        })
      ).statusCode,
    ).toBe(404);
    expect((await update(false)).statusCode).toBe(200);
    expect(
      (await apps.remote.inject({ url: "/v1/workspaces", headers })).json()
        .data,
    ).toHaveLength(1);
  } finally {
    await apps.remote.close();
    await apps.admin.close();
    await store.close();
    await rm(parent, { recursive: true, force: true });
  }
});
test("event replay includes new projects only with all-project authorization", () => {
  const b = new ReplayBuffer(),
    start = b.append({ kind: "hostChanged" });
  b.append({ kind: "messageChanged", workspaceId: "ws_new" });
  expect(b.replay(start.id, []).events).toHaveLength(0);
  expect((b.replay as any)(start.id, [], true).events).toHaveLength(1);
});
