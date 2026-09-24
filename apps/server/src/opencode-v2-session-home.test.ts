import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createV2SessionHomes } from "./opencode-v2-session-home.js";
import { resolveServerConfig } from "./config.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "session-home-")));
  roots.push(root);
  const config = await resolveServerConfig({ configPath: join(root, "server.json"), workspaces: [root] });
  return { root, config };
}

test("recovers the first move across paginated history and persists the home across resolver instances", async () => {
  const { config } = await fixture();
  const session = { id: "ses_moved", location: { directory: "/working/third" } };
  const paths: string[] = [];
  const homes = createV2SessionHomes(config, async path => {
    paths.push(path);
    return path.includes("cursor=second")
      ? { data: [{ type: "location-switched", previous: { location: { directory: "/home/original" } }, location: { directory: "/working/second" } }] }
      : { data: [{ type: "user" }], cursor: { next: "second" } };
  });
  expect(await homes.resolve(session)).toBe("/home/original");
  expect(paths).toHaveLength(2);
  const reopened = createV2SessionHomes(config, async () => { throw new Error("History must not be rescanned"); });
  expect(await reopened.resolve(session)).toBe("/home/original");
  expect(await reopened.project({ info: session })).toEqual({ info: { ...session, openworkHomeDirectory: "/home/original" } });
});

test("children created after a move inherit the parent's home, not a forged client label", async () => {
  const { config } = await fixture();
  const parent = { id: "ses_parent", location: { directory: "/working/child" } };
  const homes = createV2SessionHomes(config, async () => parent);
  await homes.remember(parent.id, "/home/parent");
  expect(await homes.resolve({ id: "ses_child", parentID: parent.id, location: parent.location,
    openworkHomeDirectory: "/foreign" })).toBe("/home/parent");
});

test("failed history reads cannot bind a moved session to its current folder", async () => {
  const { config } = await fixture();
  const homes = createV2SessionHomes(config, async () => { throw new Error("offline"); });
  await expect(homes.resolve({ id: "ses_missing", location: { directory: "/working" } })).rejects.toThrow("offline");
  expect(await homes.stored("ses_missing")).toBeNull();
});

test("the proxy keeps moved history, actions, active state and events in the home without granting the destination access", async () => {
  const { proxyOpencodeV2Request } = await import("./server.js");
  const { config, root } = await fixture();
  config.readOnly = false;
  const home = config.workspaces[0];
  if (!home) throw new Error("Missing fixture workspace");
  const destination = join(root, "worktree");
  const elsewhere = join(root, "elsewhere");
  const sessions = [
    { id: "ses_moved", location: { directory: destination } },
    { id: "ses_foreign", location: { directory: home.path } },
  ];
  const actions: { path: string; directory: string | null }[] = [];
  const native = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/session") return Response.json({ data: sessions, cursor: {} });
    if (url.pathname === "/api/session/active") return Response.json({ data: { ses_moved: { type: "running" }, ses_foreign: { type: "running" } } });
    if (url.pathname === "/api/event") return new Response([
      { type: "session.moved", location: { directory: destination }, data: { sessionID: "ses_moved", location: { directory: destination } } },
      { type: "session.execution.started", data: { sessionID: "ses_foreign" } },
      { type: "session.execution.interrupted", data: { sessionID: "ses_moved", reason: "user" } },
      { type: "session.deleted", location: { directory: destination }, data: { sessionID: "ses_moved" } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    const id = url.pathname.split("/")[3];
    if (request.method === "GET" && url.pathname.endsWith("/message")) return Response.json({ data: [{
      type: "location-switched", previous: { location: { directory: id === "ses_moved" ? home.path : elsewhere } },
    }] });
    if (request.method === "GET") return Response.json({ data: sessions.find(session => session.id === id) });
    actions.push({ path: url.pathname, directory: url.searchParams.get("location[directory]") });
    return Response.json({ data: { interrupted: true } });
  } });
  const call = (path: string, method = "GET", workspace = home) => {
    const request = new Request(`http://openwork.test${path}`, { method });
    return proxyOpencodeV2Request({ config, workspace, request, url: new URL(request.url), proxyPath: `/opencode2${path}`,
      actor: { type: "host", scope: "owner" }, connection: { url: `http://127.0.0.1:${native.port}`, username: "opencode", password: "test" },
      syncWorkspaceSkills: async () => {},
    });
  };
  try {
    const first = await call("/api/session");
    expect(await first.json()).toMatchObject({ data: [{ id: "ses_moved", openworkHomeDirectory: home.path }] });
    expect((await call("/api/session/ses_moved")).status).toBe(200);
    expect((await call("/api/session/ses_moved/interrupt", "POST")).status).toBe(200);
    expect(actions).toEqual([{ path: "/api/session/ses_moved/interrupt", directory: destination }]);
    await expect(call("/api/session/ses_moved/interrupt", "POST", { ...home, id: "other", path: destination })).rejects.toMatchObject({ status: 404 });
    await expect(call("/api/session/ses_foreign")).rejects.toMatchObject({ status: 404 });
    expect(actions).toHaveLength(1);
    expect(await (await call("/api/session/active")).json()).toEqual({ data: { ses_moved: { type: "running" } } });
    const stream = await (await call("/api/event")).text();
    expect(stream).toContain('"session.moved"');
    expect(stream).toContain('"session.execution.interrupted"');
    expect(stream).toContain('"session.deleted"');
    expect(stream).not.toContain("ses_foreign");
    expect(stream).toContain(`"openworkHomeDirectory":${JSON.stringify(home.path)}`);
  } finally { native.stop(true); }
});


test("moved questions and approvals are recovered by home, with nested form events and replies scoped to their session", async () => {
  const { proxyOpencodeV2Request } = await import("./server.js");
  const { config, root } = await fixture();
  config.readOnly = false;
  const home = config.workspaces[0];
  if (!home) throw new Error("Missing fixture workspace");
  const destination = join(root, "worktree");
  const elsewhere = join(root, "elsewhere");
  const sessions = [
    { id: "ses_moved", location: { directory: destination } },
    { id: "ses_foreign", location: { directory: home.path } },
  ];
  const forms = [
    { id: "frm_moved", sessionID: "ses_moved", metadata: { kind: "question" }, fields: [{ key: "format", type: "string" }] },
    { id: "frm_foreign", sessionID: "ses_foreign", metadata: { kind: "question" }, fields: [{ key: "secret", type: "string" }] },
  ];
  const approvals = forms.map(form => ({ id: form.id.replace("frm", "per"), sessionID: form.sessionID }));
  const actions: { path: string; directory: string | null }[] = [];
  const native = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/session") {
      return Response.json(url.searchParams.has("cursor") ? { data: [sessions[0]], cursor: {} }
        : { data: [sessions[1]], cursor: { next: "page-two" } });
    }
    if (url.pathname === "/api/form/request") return Response.json({ data: [forms[1]], location: { directory: home.path } });
    if (url.pathname === "/api/permission/request") return Response.json({ data: [approvals[1]] });
    if (url.pathname === "/api/event") return new Response([
      { type: "form.created", location: { directory: destination }, data: { form: forms[0] } },
      { type: "form.created", location: { directory: home.path }, data: { form: forms[1] } },
      { type: "form.replied", location: { directory: destination }, data: { sessionID: "ses_moved", id: "frm_moved" } },
      { type: "form.cancelled", location: { directory: destination }, data: { sessionID: "ses_moved", id: "frm_moved" } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    const id = url.pathname.split("/")[3];
    if (request.method === "GET" && url.pathname.endsWith("/message")) return Response.json({ data: [{
      type: "location-switched", previous: { location: { directory: id === "ses_moved" ? home.path : elsewhere } },
    }] });
    if (request.method === "GET" && url.pathname.endsWith("/form")) return Response.json({ data: forms.filter(form => form.sessionID === id) });
    if (request.method === "GET" && url.pathname.endsWith("/permission")) return Response.json({ data: approvals.filter(form => form.sessionID === id) });
    if (request.method === "GET") return Response.json({ data: sessions.find(session => session.id === id) });
    actions.push({ path: url.pathname, directory: url.searchParams.get("location[directory]") });
    return new Response(null, { status: 204 });
  } });
  const call = (path: string, method = "GET", workspace = home) => {
    const request = new Request(`http://openwork.test${path}`, { method });
    return proxyOpencodeV2Request({ config, workspace, request, url: new URL(request.url), proxyPath: `/opencode2${path}`,
      actor: { type: "host", scope: "owner" }, connection: { url: `http://127.0.0.1:${native.port}`, username: "opencode", password: "test" },
      syncWorkspaceSkills: async () => {},
    });
  };
  try {
    // Creation nests sessionID inside data.form, unlike the other session events.
    const events = await (await call("/api/event")).text();
    expect(events).toContain('"form.created"');
    expect(events).toContain('"form.replied"');
    expect(events).toContain('"form.cancelled"');
    expect(events).not.toContain("ses_foreign");
    expect(await (await call("/api/form/request")).json()).toMatchObject({ data: [forms[0]] });
    expect(await (await call("/api/permission/request")).json()).toMatchObject({ data: [approvals[0]] });
    for (const suffix of ["form/frm_moved/reply", "form/frm_moved/cancel", "permission/per_moved/reply"]) {
      expect((await call(`/api/session/ses_moved/${suffix}`, "POST")).status).toBe(204);
      expect(actions.at(-1)?.directory).toBe(destination);
      await expect(call(`/api/session/ses_moved/${suffix}`, "POST", { ...home, id: "other", path: destination })).rejects.toMatchObject({ status: 404 });
    }
    expect(actions).toHaveLength(3);
    expect(await (await call("/api/form/request", "GET", { ...home, id: "other", path: destination })).json()).toMatchObject({ data: [] });
  } finally { native.stop(true); }
});
