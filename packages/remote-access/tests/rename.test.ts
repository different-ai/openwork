import { test, expect } from "vitest";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenWorkV2 } from "../src/adapters/openwork-v2-01857.js";
import { createServers } from "../src/server.js";
import { Store } from "../src/storage/store.js";
import { Pairing } from "../src/auth/pairing.js";

async function fixture(run: (api: ReturnType<typeof createServers>, state: { title: string; writes: number; loseReply: boolean }) => Promise<void>) {
  const state = { title: "Original chat", writes: 0, loseReply: false };
  const upstream = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") {
      expect(req.url).toBe("/workspace/ws_test/opencode2/api/session/ses_test/rename");
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      expect(Object.keys(body)).toEqual(["title"]);
      state.title = body.title;
      state.writes++;
      if (state.loseReply) { req.socket.destroy(); return; }
    }
    if (req.url?.includes("ses_missing")) { res.writeHead(404); res.end("{}"); return; }
    res.end(JSON.stringify(req.url === "/health" ? { ok: true, version: "0.18.57" }
      : { data: { id: "ses_test", title: state.title, time: { created: 0 } } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  const adapter = new OpenWorkV2(async () => ({ origin: `http://127.0.0.1:${address.port}`, token: "synthetic" }));
  await adapter.health();
  const folder = await mkdtemp(join(tmpdir(), "owr-rename-"));
  const store = await Store.open(join(folder, "state"));
  await store.update((s) => { s.devices.push({ id: "device", deviceId: "phone", name: "Phone",
    tokenHash: createHash("sha256").update("synthetic").digest("hex"), workspaceIds: ["ws_test"], active: true, revoked: false }); });
  const api = createServers({ store, pairing: new Pairing(store), adapter, platform: "macos", architecture: "arm64", origin: "https://host.test" });
  try { await run(api, state); }
  finally {
    await api.remote.close(); await api.admin.close(); await store.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(folder, { recursive: true, force: true });
  }
}
const headers = { authorization: "Bearer synthetic" };
const url = "/v1/workspaces/ws_test/sessions/ses_test/rename";
const payload = () => ({ requestId: randomUUID(), title: "Renamed chat", previousTitle: "Original chat" });

test("rename updates the existing chat and replay does not forward twice", async () => fixture(async (api, state) => {
  const request = { method: "POST" as const, url, headers, payload: payload() };
  const first = await api.remote.inject(request);
  expect(first.statusCode).toBe(200);
  expect(first.json().data.state).toBe("accepted");
  expect(state.title).toBe("Renamed chat");
  expect((await api.remote.inject(request)).json().data).toEqual(first.json().data);
  expect(state.writes).toBe(1);
  const read = await api.remote.inject({ url: url.replace("/rename", ""), headers });
  expect(read.json().data.title).toBe("Renamed chat");
}));

test("rename rejects invalid names, unauthenticated and out-of-scope access, and stale titles", async () => fixture(async (api, state) => {
  for (const title of ["", "   ", "x".repeat(201)]) {
    expect((await api.remote.inject({ method: "POST", url, headers, payload: { ...payload(), title } })).statusCode).toBe(400);
  }
  expect((await api.remote.inject({ method: "POST", url, payload: payload() })).statusCode).toBe(401);
  expect((await api.remote.inject({ method: "POST", url: url.replace("ws_test", "ws_other"), headers, payload: payload() })).statusCode).toBe(403);
  expect((await api.remote.inject({ method: "POST", url: url.replace("ses_test", "ses_missing"), headers, payload: payload() })).statusCode).toBe(404);
  state.title = "Changed on desktop";
  expect((await api.remote.inject({ method: "POST", url, headers, payload: payload() })).statusCode).toBe(409);
  expect(state.writes).toBe(0);
}));

test("a lost rename response is recorded as uncertain and is never automatically repeated", async () => fixture(async (api, state) => {
  state.loseReply = true;
  const request = { method: "POST" as const, url, headers, payload: payload() };
  const first = await api.remote.inject(request);
  expect(first.json().data.state).toBe("outcome_unknown");
  expect((await api.remote.inject(request)).json().data.state).toBe("outcome_unknown");
  expect(state.writes).toBe(1);
}));
