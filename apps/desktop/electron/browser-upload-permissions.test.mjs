import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { browserUploadOrigin, createBrowserUploadGrantStore, createBrowserUploadPermissions } from "./browser-upload-permissions.mjs";

const scope = { baseUrl: "https://den.example.test", organizationId: "org_fixture", memberId: "member_fixture" };
const site = "https://studio.example.test";
const policy = (rules = []) => ({ enabled: true, scope, rules });
const rule = (effect, resource = "*") => ({ action: "browser_upload", resource, effect, source: "Everyone" });
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "upload-permissions-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = path.join(root, "approved");
  await mkdir(folder);
  const file = path.join(folder, "clip.mp4");
  await writeFile(file, "fixture clip");
  const outside = path.join(root, "outside.mp4");
  await writeFile(outside, "outside");
  const directory = path.join(root, "grants");
  const store = createBrowserUploadGrantStore({ directory });
  return { root, directory, folder, file, outside, store };
}
const request = (files) => ({ app: "studio.example.test", url: `${site}/upload`, files });
const signal = () => new AbortController().signal;

test("a remembered site + chosen folder survives restart and a new Slack-created chat", async (t) => {
  const f = await fixture(t);
  let asks = 0;
  const service = createBrowserUploadPermissions({ readPolicy: async () => policy(), store: f.store,
    requestFiles: async () => { asks++; return "remember"; }, chooseFolder: async () => f.folder,
    legacyApprove: async () => { throw new Error("not legacy"); } });
  assert.equal((await service.approve("chat_first", request([f.file]), signal())).allowed, true);
  assert.equal(asks, 1);
  const restarted = createBrowserUploadPermissions({ readPolicy: async () => policy(),
    store: createBrowserUploadGrantStore({ directory: f.directory }),
    requestFiles: async () => { throw new Error("must not ask again"); }, legacyApprove: async () => false });
  assert.equal((await restarted.approve("chat_from_slack", request([f.file]), signal())).allowed, true);
  const listed = await restarted.list();
  assert.deepEqual(listed.grants.map(({ origin, folder }) => ({ origin, folder })), [{ origin: site, folder: f.folder }]);
});

test("remembered consent is isolated by deployment, organization, member, origin, scheme and port", async (t) => {
  const f = await fixture(t);
  await f.store.remember(scope, site, f.folder, [f.file]);
  for (const other of [{ ...scope, baseUrl: "https://other.example.test" }, { ...scope, organizationId: "org_other" }, { ...scope, memberId: "member_other" }]) {
    assert.equal(await f.store.covers(other, site, [f.file]), false);
  }
  for (const otherSite of ["http://studio.example.test", "https://studio.example.test:8443", "https://sub.studio.example.test", "https://evil.example.test"]) {
    assert.equal(await f.store.covers(scope, otherSite, [f.file]), false);
  }
  assert.equal(await f.store.covers(scope, site, [f.outside]), false);
  assert.equal(await f.store.covers(scope, site, [f.file, f.outside]), false, "every file in a batch must be within the folder");
  assert.equal(browserUploadOrigin("https://user:pass@studio.example.test"), null);
  assert.equal(browserUploadOrigin("file:///tmp/a.txt"), null);
});

test("paths cannot escape a remembered folder through a link, sibling name or traversal", async (t) => {
  const f = await fixture(t);
  await f.store.remember(scope, site, f.folder, [f.file]);
  const sibling = `${f.folder}-sibling`;
  await mkdir(sibling);
  const siblingFile = path.join(sibling, "a.mp4");
  await writeFile(siblingFile, "not covered");
  const link = path.join(f.folder, "link.mp4");
  await symlink(f.outside, link);
  for (const candidate of [link, siblingFile, `${f.folder}/../outside.mp4`]) {
    assert.equal(await f.store.covers(scope, site, [candidate]), false);
  }
  await assert.rejects(f.store.remember(scope, site, f.folder, [link]));
});

test("admin Block dominates remembered grants; explicit Ask always asks; explicit Allow needs no prompt", async (t) => {
  const f = await fixture(t);
  await f.store.remember(scope, site, f.folder, [f.file]);
  let rules = [rule("deny")], asks = 0;
  const service = createBrowserUploadPermissions({ store: f.store, readPolicy: async () => policy(rules),
    requestFiles: async ({ canRemember }) => { asks++; assert.equal(canRemember, false); return "allow"; } });
  assert.equal((await service.approve("chat", request([f.file]), signal())).code, "organization_policy_denied");
  assert.equal(asks, 0);
  rules = [rule("ask")];
  assert.equal((await service.approve("chat", request([f.file]), signal())).allowed, true);
  assert.equal(asks, 1);
  rules = [rule("allow")];
  assert.equal((await service.approve("chat", request([f.file]), signal())).allowed, true);
  assert.equal(asks, 1);
  rules = [rule("allow"), rule("deny", "studio.example.test")];
  assert.equal((await service.approve("chat", request([f.file]), signal())).code, "organization_policy_denied");
});

test("policy and account changes while a person approves cannot authorize or persist the old request", async (t) => {
  const f = await fixture(t);
  let active = policy();
  const service = createBrowserUploadPermissions({ store: f.store, readPolicy: async () => active,
    requestFiles: async () => { active = { ...policy(), scope: { ...scope, memberId: "member_other" } }; return "remember"; },
    chooseFolder: async () => f.folder });
  assert.equal(await service.approve("chat", request([f.file]), signal()), false);
  assert.deepEqual(await f.store.list(scope), []);
});

test("revocation, an account switch or an administrative change invalidates an authorization before attachment", async (t) => {
  const f = await fixture(t);
  await f.store.remember(scope, site, f.folder, [f.file]);
  let active = policy();
  const service = createBrowserUploadPermissions({ store: f.store, readPolicy: async () => active, requestFiles: async () => "dismiss" });
  const authorization = await service.approve("chat", request([f.file]), signal());
  assert.equal(await authorization.revalidate(), true);
  active = policy([rule("deny")]);
  assert.equal(await authorization.revalidate(), false);
  active = policy();
  const fresh = await service.approve("chat", request([f.file]), signal());
  const listed = await service.list();
  await service.remove(listed.grants[0].id);
  assert.equal(await fresh.revalidate(), false);
  assert.equal(await service.approve("chat_from_slack", request([f.file]), signal()), false);
});

test("feature off keeps legacy chat-only approval; unavailable policy never uses remembered grants", async (t) => {
  const f = await fixture(t);
  let legacy = 0;
  const service = createBrowserUploadPermissions({ store: f.store, readPolicy: async () => ({ enabled: false, scope: null, rules: [] }),
    legacyApprove: async () => { legacy++; return true; }, requestFiles: async () => { throw new Error("not enabled"); } });
  assert.equal(await service.approve("chat", request([f.file]), signal()), true);
  assert.equal(legacy, 1);
  assert.deepEqual(await service.list(), { enabled: false, grants: [] });
  const offline = createBrowserUploadPermissions({ store: f.store, readPolicy: async () => { throw new Error("offline"); } });
  await assert.rejects(offline.approve("chat", request([f.file]), signal()), /offline/);
});

test("corrupt grants fail closed instead of being silently reset, and contain no credentials", async (t) => {
  const f = await fixture(t);
  await f.store.remember(scope, site, f.folder, [f.file]);
  const [name] = await readdir(f.directory);
  const saved = await readFile(path.join(f.directory, name), "utf8");
  assert.ok(!saved.includes("token") && !saved.includes(scope.memberId));
  await writeFile(path.join(f.directory, name), '{"version":1,"grants":[{"origin":"*"}]}');
  await assert.rejects(f.store.covers(scope, site, [f.file]), /invalid/);
  await assert.rejects(f.store.remember(scope, site, f.folder, [f.file]), /invalid/);
});
