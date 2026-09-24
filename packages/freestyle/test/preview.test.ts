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
    if (path.includes("/fs/")) { writes.push(await new Response(init?.body).text()); return Response.json({}); }
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
  await assert.rejects(ensureSnapshot(sha, api, undefined, "app-web", {
    sourceFetch: async () => Response.json({ truncated: false, tree: [{ path: "pnpm-lock.yaml", sha, type: "blob" }] }),
  }), /No capacity/);
});

test("desktop templates use their own runtime and refresh an exact frontend-only revision without world services", async () => {
  const snapshots = new Map<string, { id: string; slug: string; createdAt: string }>();
  const writes: { path: string; text: string }[] = [];
  const creates: { snapshotId: string }[] = [];
  let count = 0;
  const api = new Freestyle({ apiKey: "synthetic", fetch: async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path.startsWith("/v5/snapshots/")) {
      const saved = snapshots.get(path.split("/").pop() ?? "");
      return saved ? Response.json(saved) : Response.json({ code: "NOT_FOUND" }, { status: 404 });
    }
    if (path === "/v5/vms" && init?.method === "POST") {
      const body: unknown = JSON.parse(String(init.body));
      assert.ok(body && typeof body === "object" && "snapshotId" in body && typeof body.snapshotId === "string");
      creates.push({ snapshotId: body.snapshotId });
      return Response.json({ id: `builder-${creates.length}` });
    }
    if (path.endsWith("/fs/write")) {
      writes.push({ path: url.searchParams.get("path") ?? "", text: await new Response(init?.body).text() });
      return Response.json({});
    }
    if (path.endsWith("/fs/exists")) return Response.json({ exists: url.searchParams.get("path")?.endsWith(".ready") });
    if (path.endsWith("/fs/read")) {
      assert.ok(url.searchParams.get("path")?.endsWith("build-stages.jsonl"));
      return new Response(JSON.stringify({ stage: "boot-and-verify", durationMs: 1 }));
    }
    if (path.endsWith("/exec-await")) return Response.json({ statusCode: 0, stdout: "" });
    if (path.endsWith("/snapshot")) {
      const body: unknown = JSON.parse(String(init?.body));
      assert.ok(body && typeof body === "object" && "slug" in body && typeof body.slug === "string");
      const snapshot = { id: `snapshot-${++count}`, slug: body.slug, createdAt: new Date().toISOString() };
      snapshots.set(body.slug, snapshot);
      return Response.json({ snapshotId: snapshot.id, snapshot });
    }
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error("Unexpected mocked builder operation");
  } });
  const source = (revision: string) => async () => Response.json({ truncated: false, tree: [
    { path: "pnpm-lock.yaml", sha, type: "blob" },
    { path: "apps/app/src/main.tsx", sha: revision, type: "blob" },
  ] });
  const first = await ensureSnapshot(sha, api, undefined, "desktop", { sourceFetch: source(sha) });
  assert.equal(creates.length, 5);
  assert.ok([...snapshots.keys()].every((slug) => slug.includes("-desktop-")));
  const text = (name: string) => writes.find((item) => item.path === `/opt/openwork-preview/${name}`)?.text ?? "";
  assert.match(text("runtime.mjs"), /bootDesktopOnly/);
  assert.doesNotMatch(text("runtime.mjs"), /bootAcme|signIn|bootstrap|modelId/);
  assert.match(text("health.mjs"), /inspectDesktop/);
  assert.doesNotMatch(text("health.mjs"), /services\.engine|resume\.mjs/);
  assert.match(text("refresh.mjs"), /refreshDesktop/);
  assert.doesNotMatch(text("refresh.mjs"), /services\.app|resume\.mjs|signInDesktopAs/);
  assert.match(text("desktop-state.mjs"), /firstRun/);
  const secondSha = "b".repeat(40);
  const second = await ensureSnapshot(secondSha, api, undefined, "desktop", { sourceFetch: source(secondSha) });
  assert.notEqual(first.id, second.id);
  assert.equal(creates.length, 6, "frontend-only commits reuse the running desktop template");
  const refresh = writes.filter((item) => item.path.endsWith("/refresh.sh")).at(-1)?.text ?? "";
  assert.ok(refresh.includes(`git fetch --depth=1 origin ${secondSha}`));
  assert.ok(refresh.includes(`node /opt/openwork-preview/refresh.mjs ${secondSha}`));
  assert.doesNotMatch(refresh, /resume\.mjs|health\.mjs|git clean/);
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

test("the review page accepts every service link an ACME launch returns, including the desktop viewer", async () => {
  const { parsePreviewOutputs } = await import("../src/outputs.ts");
  const ready = mockApi(undefined, { "outputs.json": JSON.stringify({ desktopStatus: { value: "ready", group: "Desktop" } }) });
  const session = await launchPreview({ gitSha: sha, world: "acme-web" }, ready.api, reachable);
  // The browser re-validates the launch response; a rejected link hides a working sandbox.
  const parsed = parsePreviewOutputs(JSON.parse(JSON.stringify(session.outputs)));
  assert.ok(parsed.desktopUrl, "the desktop viewer link must survive client validation");
  assert.throws(() => parsePreviewOutputs({ desktopUrl: { value: "https://evil.example/__openwork_launch?token=x", group: "Services" } }), /Invalid private service link/);
});

const desktopFiles = {
  "source-sha": sha,
  "status": "ready-signed-out",
  "outputs.json": JSON.stringify({ desktopStatus: { value: "ready-signed-out", group: "Desktop" } }),
};
const desktopReachable: typeof fetch = async (input) => new URL(String(input)).pathname === "/vnc.html"
  ? new Response("<title>noVNC</title>") : reachable(input);

test("desktop clones use only their viewer, isolated access and exact source even for old snapshots", async () => {
  const provider = mockApi("2020-01-01T00:00:00Z", desktopFiles);
  const [first, second] = await Promise.all([
    launchPreview({ gitSha: sha, world: "desktop", lifetimeMinutes: 10 }, provider.api, desktopReachable),
    launchPreview({ gitSha: sha, world: "desktop", lifetimeMinutes: 10 }, provider.api, desktopReachable),
  ]);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.url, second.url);
  assert.notEqual(first.outputs.previewCookie.value, second.outputs.previewCookie.value);
  assert.equal(first.snapshotId, second.snapshotId);
  assert.equal(first.url, first.outputs.desktopUrl.value);
  assert.deepEqual(Object.keys(first.outputs).sort(), ["desktopStatus", "desktopUrl", "previewCookie"]);
  assert.deepEqual(provider.commands, []);
  for (const [index, session] of [first, second].entries()) {
    const domain = new URL(session.url).hostname;
    assert.match(domain, /^desktop-[a-f0-9]{32}\.preview\.openwork\.software$/);
    assert.equal(provider.creates[index].ttlSeconds, 600);
    assert.deepEqual(provider.creates[index].tls, { rules: [{ action: "allow", domain, source: { public: true }, destination: { port: 8080 } }] });
    const access = JSON.parse(provider.writes[index]);
    assert.deepEqual(access.origins, { desktop: `https://${domain}` });
    assert.equal(access.templateOrigins, undefined);
    assert.equal(access.expiresAt, session.expiresAt);
  }
  assert.notEqual(snapshotSlug(sha, "desktop"), snapshotSlug(sha, "app-web"));
  assert.notEqual(snapshotSlug(sha, "desktop"), snapshotSlug(sha, "acme-web"));
});

for (const files of [
  { ...desktopFiles, "source-sha": "b".repeat(40) },
  { ...desktopFiles, "status": "starting" },
  { ...desktopFiles, "outputs.json": JSON.stringify({ webUrl: { value: "unwanted" } }) },
]) {
  test("invalid desktop snapshot fails closed and deletes its clone", async () => {
    const provider = mockApi(undefined, files);
    await assert.rejects(launchPreview({ gitSha: sha, world: "desktop" }, provider.api, desktopReachable), /could not be reached/);
    assert.deepEqual(provider.deleted, ["/v5/vms/vm-1"]);
    assert.deepEqual(provider.commands, []);
  });
}

test("desktop viewer readiness failure cleans up and does not accept web HTML", async () => {
  const provider = mockApi(undefined, desktopFiles);
  await assert.rejects(launchPreview({ gitSha: sha, world: "desktop" }, provider.api, async () => new Response(null, { status: 401 })), /could not be reached/);
  assert.deepEqual(provider.deleted, ["/v5/vms/vm-1"]);
  await assert.rejects(waitForPublicAccess("https://unused.example", reachable, async () => undefined, "desktop"), /Public sandbox readiness failed/);
});

test("ACME clones link the desktop viewer only when the snapshot started the desktop", async () => {
  const ready = mockApi(undefined, { "outputs.json": JSON.stringify({ desktopStatus: { value: "starting", group: "Desktop" } }) });
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
  const older = mockApi();
  assert.equal((await launchPreview({ gitSha: sha, world: "acme-web" }, older.api, reachable)).outputs.desktopUrl, undefined, "snapshots from before this change are unaffected");
});

test("ACME launches return only after every linked service hostname routes to the clone", async () => {
  const handshakes = (seen: string[]): typeof fetch => async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/__openwork_launch") seen.push(url.hostname.split("-")[0]);
    return reachable(input, init);
  };
  const withDesktop: string[] = [];
  await launchPreview({ gitSha: sha, world: "acme-web" }, mockApi(undefined, { "outputs.json": JSON.stringify({ desktopStatus: { value: "ready", group: "Desktop" } }) }).api, handshakes(withDesktop));
  assert.deepEqual(withDesktop.sort(), ["api", "den", "desktop", "engine", "gateway", "ow"]);
  const withoutDesktop: string[] = [];
  await launchPreview({ gitSha: sha, world: "acme-web" }, mockApi(undefined, { "outputs.json": JSON.stringify({ desktopStatus: { value: "unavailable", group: "Desktop" } }) }).api, handshakes(withoutDesktop));
  assert.deepEqual(withoutDesktop.sort(), ["api", "den", "engine", "gateway", "ow"], "an unlinked desktop is not required to route");

  const dead = mockApi();
  await assert.rejects(launchPreview({ gitSha: sha, world: "acme-web" }, dead.api, async (input, init) =>
    new URL(String(input)).hostname.startsWith("api-") ? new Response(null, { status: 403 }) : reachable(input, init)), /could not be reached/);
  assert.deepEqual(dead.deleted, ["/v5/vms/vm-1"], "a clone whose links do not route is deleted, not handed out");
});
