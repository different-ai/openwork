import assert from "node:assert/strict";
import test from "node:test";
import { Freestyle } from "freestyle";
import { deletePreview, findSnapshot, launchPreview, snapshotSlug, waitForPublicAccess } from "../src/index.ts";
import { ensureSnapshot } from "../src/builder.ts";

const sha = "a".repeat(40);
function mockApi(snapshotCreatedAt = new Date().toISOString(), files: Record<string, string> = {}) {
  const creates: Record<string, unknown>[] = [];
  const writes: string[] = [];
  const deleted: string[] = [];
  const commands: string[] = [];
  const api = new Freestyle({ apiKey: "synthetic", fetch: async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.startsWith("/v5/snapshots/")) return Response.json({ id: "sh-template", slug: snapshotSlug(sha), createdAt: snapshotCreatedAt });
    if (path === "/v5/vms" && init?.method === "POST") {
      const body: unknown = JSON.parse(String(init.body));
      assert.ok(typeof body === "object" && body !== null && !Array.isArray(body));
      creates.push(Object.fromEntries(Object.entries(body)));
      return Response.json({ id: `vm-${creates.length}`, createdAt: new Date().toISOString() });
    }
    const guestPath = new URL(String(input)).searchParams.get("path") ?? "";
    const file = Object.entries(files).find(([name]) => guestPath.endsWith(`/${name}`));
    if (path.includes("/fs/") && file && (init?.method ?? "GET") === "GET") return new Response(file[1]);
    if (path.includes("/fs/")) { writes.push(String(init?.body)); return Response.json({}); }
    if (path.endsWith("/exec-await")) { commands.push(String(init?.body)); return Response.json({ statusCode: 0, stdout: "" }); }
    if (init?.method === "DELETE") { deleted.push(path); return new Response(null, { status: 204 }); }
    throw new Error(`Unexpected provider request ${init?.method} ${path}`);
  } });
  return { api, creates, writes, deleted, commands };
}

const reachable: typeof fetch = async (input) => new URL(String(input)).pathname === "/__openwork_launch"
  ? new Response(null, { status: 303, headers: { "set-cookie": "__Host-openwork-preview=synthetic" } })
  : new Response("<title>OpenWork</title>", { status: 200 });

test("concurrent launches from one report get separate VMs, credentials and provider expiry", async () => {
  const { api, creates, writes } = mockApi();
  const [first, second] = await Promise.all([
    launchPreview({ gitSha: sha, reportId: "b".repeat(32) }, api, reachable),
    launchPreview({ gitSha: sha, reportId: "b".repeat(32) }, api, reachable),
  ]);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.url, second.url);
  assert.notEqual(new URL(first.url).searchParams.get("token"), new URL(second.url).searchParams.get("token"));
  assert.equal(first.snapshotId, second.snapshotId);
  assert.ok(new URL(first.url).hostname.endsWith(".preview.openwork.software"));
  assert.equal(creates.length, 2);
  for (const body of creates) {
    assert.equal(body.snapshotId, "sh-template");
    assert.equal(body.ttlSeconds, 7200);
    assert.ok(body.tls); // Domain lifetime is bound to its VM.
  }
  assert.equal(writes.length, 2);
});

test("failed public readiness cleans up the newly allocated VM", async () => {
  const { api, deleted } = mockApi();
  await assert.rejects(launchPreview({ gitSha: sha }, api, async () => new Response(null, { status: 401 })), /could not be reached/);
  assert.deepEqual(deleted, ["/v5/vms/vm-1"]);
});

test("new public routes can recover from propagation errors without allocating another VM", async () => {
  const { api, creates, deleted } = mockApi();
  let attempts = 0;
  await launchPreview({ gitSha: sha }, api, async (input) => {
    attempts++;
    if (attempts === 1) return new Response(null, { status: 502 });
    return reachable(input);
  });
  assert.equal(attempts, 3);
  assert.equal(creates.length, 1);
  assert.deepEqual(deleted, []);
});

test("launch waits through the restored app's first transient 502", async () => {
  const { api, creates } = mockApi();
  let pageRequests = 0;
  await launchPreview({ gitSha: sha }, api, async (input) => {
    if (new URL(String(input)).pathname === "/") {
      pageRequests++;
      if (pageRequests === 1) return new Response("starting", { status: 502 });
    }
    return reachable(input);
  });
  assert.equal(pageRequests, 2);
  assert.equal(creates.length, 1);
});

test("fresh ACME clones skip guest startup while old snapshots rotate their demo session", async () => {
  const fresh = mockApi();
  const ready = await launchPreview({ gitSha: sha, world: "acme-web" }, fresh.api, reachable);
  assert.equal(fresh.commands.length, 0);
  assert.ok(ready.outputs.denWeb?.value.includes("__openwork_launch"));
  const old = mockApi(new Date(Date.now() - 6 * 24 * 60 * 60_000).toISOString());
  await launchPreview({ gitSha: sha, world: "acme-web" }, old.api, reachable);
  assert.equal(old.commands.length, 1);
  assert.match(old.commands[0], /resume\.mjs/);
});

test("public readiness retries are bounded and do not conceal denied access", async () => {
  let attempts = 0;
  await assert.rejects(waitForPublicAccess("https://unused.example", async () => {
    attempts++;
    throw new TypeError("fetch failed");
  }, async () => undefined), /Public sandbox readiness failed/);
  assert.equal(attempts, 8);
  attempts = 0;
  await assert.rejects(waitForPublicAccess("https://unused.example", async () => {
    attempts++;
    return new Response(null, { status: 401 });
  }, async () => undefined), /HTTP 401/);
  assert.equal(attempts, 1);
});

test("unknown snapshots and invalid revisions never allocate VMs", async () => {
  let calls = 0;
  const api = new Freestyle({ apiKey: "synthetic", fetch: async () => {
    calls += 1;
    return Response.json({ code: "NOT_FOUND", message: "Missing" }, { status: 404 });
  } });
  assert.throws(() => snapshotSlug("dev; echo nope"), /full pushed/);
  assert.equal(await findSnapshot(sha, api), null);
  await assert.rejects(launchPreview({ gitSha: sha }, api, reachable), /no Freestyle snapshot/);
  assert.equal(calls, 2);
});

test("cleanup refuses unrelated VMs", async () => {
  const api = new Freestyle({ apiKey: "synthetic", fetch: async (_url, init) => {
    assert.notEqual(init?.method, "DELETE");
    return Response.json({ id: "vm-unrelated", metadata: {} });
  } });
  await assert.rejects(deletePreview("vm-unrelated", api), /not owned/);
});

test("provider capacity conflicts do not masquerade as an in-progress snapshot", async () => {
  const api = new Freestyle({ apiKey: "synthetic", fetch: async (_url, init) => {
    if (init?.method === "POST") return Response.json({ code: "CONFLICT", message: "No capacity" }, { status: 409 });
    return Response.json({ code: "NOT_FOUND", message: "Missing" }, { status: 404 });
  } });
  await assert.rejects(ensureSnapshot(sha, api), /No capacity/);
});

test("an existing immutable snapshot is reused without creating a builder", async () => {
  const { api, creates } = mockApi();
  assert.equal((await ensureSnapshot(sha, api)).id, "sh-template");
  assert.equal(creates.length, 0);
});

test("snapshot identity separates worlds and rejects unknown recipes", async () => {
  const { previewWorld } = await import("../src/index.ts");
  assert.notEqual(snapshotSlug(sha, "app-web"), snapshotSlug(sha, "acme-web"));
  assert.throws(() => previewWorld("arbitrary-command"), /Unsupported/);
});

test("world outputs accept disposable credentials but reject malformed values", async () => {
  const { parsePreviewOutputs } = await import("../src/outputs.ts");
  assert.deepEqual(parsePreviewOutputs({ password: { value: "synthetic", secret: true, group: "Accounts" } }), {
    password: { value: "synthetic", secret: true, group: "Accounts" },
  });
  assert.throws(() => parsePreviewOutputs({ password: { value: {}, secret: true } }), /Invalid/);
  assert.throws(() => parsePreviewOutputs({ password: { value: "synthetic", secret: "false" } }), /Invalid/);
});

test("ACME clones route the real desktop viewer only when the snapshot booted it", async () => {
  const ready = mockApi(undefined, { "outputs.json": JSON.stringify({ desktopStatus: { value: "ready", group: "Desktop" } }) });
  const session = await launchPreview({ gitSha: sha, world: "acme-web" }, ready.api, reachable);
  const desktop = new URL(session.outputs.desktopUrl?.value ?? "https://missing.invalid");
  assert.match(desktop.hostname, /^desktop-[a-f0-9]{32}\.preview\.openwork\.software$/);
  assert.equal(desktop.pathname, "/__openwork_launch");
  assert.equal(desktop.searchParams.get("token"), new URL(session.url).searchParams.get("token"));
  assert.equal(session.outputs.desktopUrl?.group, "Services");
  const tls = ready.creates[0].tls;
  assert.ok(typeof tls === "object" && tls !== null && "rules" in tls && Array.isArray(tls.rules));
  assert.ok(tls.rules.some((rule: unknown) => typeof rule === "object" && rule !== null && "domain" in rule && rule.domain === desktop.hostname));

  const unavailable = mockApi(undefined, { "outputs.json": JSON.stringify({ desktopStatus: { value: "unavailable", group: "Desktop" } }) });
  const web = await launchPreview({ gitSha: sha, world: "acme-web" }, unavailable.api, reachable);
  assert.equal(web.outputs.desktopUrl, undefined, "a failed desktop never produces a dead link");
  assert.ok(web.outputs.webUrl?.value.includes("__openwork_launch"), "the web preview still launches");
});

test("desktop-capable snapshots use a new recipe version so older snapshots are rebuilt", () => {
  assert.match(snapshotSlug(sha, "acme-web"), /^openwork-acme-web-v5-/);
});
