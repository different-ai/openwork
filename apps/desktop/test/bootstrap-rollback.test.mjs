import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, writeFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspaceStore } from "../electron/workspace-store.mjs";
import { desktopBootstrapFromConnectClaims } from "../electron/connect-link.mjs";
import { sanitizeDesktopBootstrapFiles } from "../electron/nuke.mjs";

const dormant = {
  brandAppName: " Original desktop ",
  brandLogoUrl: "https://unused.invalid/original-logo.png",
  brandIconUrl: "https://unused.invalid/original-icon.png",
};
const target = { baseUrl: "https://den.example.test", apiBaseUrl: "https://api.example.test" };

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwork-bootstrap-rollback-"));
  const bootstrapPath = path.join(root, "desktop-bootstrap.json");
  const previousOverride = process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH;
  process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH = bootstrapPath;
  t.after(async () => {
    if (previousOverride === undefined) delete process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH;
    else process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH = previousOverride;
    await rm(root, { recursive: true, force: true });
  });
  const open = () => createWorkspaceStore({
    app: { getPath: () => root },
    defaultDenBaseUrl: "https://app.openworklabs.com",
    defaultRequireSignin: false,
    forceRequireSignin: false,
  });
  await writeFile(bootstrapPath, JSON.stringify({ ...target, ...dormant, requireSignin: true }));
  return { bootstrapPath, open, userDataPath: root };
}

function assertDormant(config) {
  for (const [key, value] of Object.entries(dormant)) assert.equal(config[key], value);
}

function assertNoDormant(config) {
  for (const key of Object.keys(dormant)) assert.equal(Object.hasOwn(config, key), false);
}

function knownOrg(kind, orgId) {
  const identity = { orgId, orgName: "Test organization", orgSlug: orgId, skillId: "test-skill", skillTitle: "Test skill" };
  return kind === "prepared" ? { prepared: {
    ...identity, skillsDir: "/unused", skillPath: "/unused/SKILL.md", preparedAt: "2026-10-13T00:00:00Z",
  } } : { handoff: {
    ...identity, grant: "unused-test-grant", denBaseUrl: target.baseUrl, createdAt: "2026-10-13T00:00:00Z",
  } };
}

async function readArchiveFiles(userDataPath) {
  const root = path.join(userDataPath, "desktop-brand-rollback");
  const names = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
  return Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readFile(path.join(root, name))])));
}

test("upgrade read/write, restart, cloud refresh, nuke preservation and rollback retain source settings", async (t) => {
  const { bootstrapPath, open } = await fixture(t);
  const upgraded = open();
  assertDormant(upgraded.readDesktopBootstrapConfigSync());
  assertDormant(await upgraded.getDesktopBootstrapConfig());
  // Ordinary renderer writes and older-server stock compatibility values are
  // not authoritative for rollback settings; the original disk values win.
  await upgraded.setDesktopBootstrapConfig({
    ...target, requireSignin: false,
    brandAppName: "OpenWork", brandLogoUrl: null, brandIconUrl: null,
  });
  const restarted = open();
  assertDormant(restarted.readDesktopBootstrapConfigSync());
  const connect = desktopBootstrapFromConnectClaims({
    den: { ...target, baseUrl: `${target.baseUrl}/` }, requireSignin: true,
    brand: { appName: "Untrusted", logoUrl: "http://unused.invalid/logo", iconUrl: "http://unused.invalid/icon" },
  });
  assertNoDormant(connect);
  await restarted.setDesktopBootstrapConfig(connect);
  assertDormant(JSON.parse(await readFile(bootstrapPath, "utf8")));
  await sanitizeDesktopBootstrapFiles({ canonicalPath: bootstrapPath, legacyPath: null });
  assertDormant(open().readDesktopBootstrapConfigSync());
  // The old version's storage contract can still read all original values.
  const rollback = JSON.parse(await readFile(bootstrapPath, "utf8"));
  assertDormant(rollback);
  assert.equal(rollback.requireSignin, true);
});

for (const [name, changed] of [
  ["web origin", { ...target, baseUrl: "https://other.example.test" }],
  ["API origin", { ...target, apiBaseUrl: "https://other-api.example.test" }],
  ["port", { ...target, baseUrl: "https://den.example.test:444" }],
]) {
  test(`connecting to a different Den ${name} never inherits or persists incoming custom values`, async (t) => {
    const { bootstrapPath, open } = await fixture(t);
    await open().setDesktopBootstrapConfig({ ...changed, ...dormant, requireSignin: true });
    assertNoDormant(JSON.parse(await readFile(bootstrapPath, "utf8")));
    assertNoDormant(await open().getDesktopBootstrapConfig());
  });
}

test("renderer all-null org-switch payload archives originals and trusted rollback restores them", async (t) => {
  const { bootstrapPath, open, userDataPath } = await fixture(t);
  const store = open();
  const previous = await store.getDesktopBootstrapConfig();
  const source = {
    "brand-icon.json": Buffer.from(JSON.stringify({ sourceUrl: dormant.brandIconUrl, hash: "original" })),
    "brand-icon.png": Buffer.from([137, 80, 78, 71, 12, 34]),
    "brand-icon.ico": Buffer.from([0, 0, 1, 0, 250]),
  };
  for (const [name, bytes] of Object.entries(source)) await writeFile(path.join(userDataPath, name), bytes);
  const originalStats = Object.fromEntries(await Promise.all(Object.keys(source).map(async (name) => [
    name, await stat(path.join(userDataPath, name)),
  ])));
  // This is the payload setDenBootstrapConfig(clearDormantBranding: true)
  // sends for a confirmed same-origin organization switch.
  const cleared = await store.setDesktopBootstrapConfig({
    ...target, requireSignin: true, brandAppName: null, brandLogoUrl: null, brandIconUrl: null,
  });
  for (const key of Object.keys(dormant)) assert.equal(cleared[key], null);
  for (const name of Object.keys(source)) await assert.rejects(access(path.join(userDataPath, name)), { code: "ENOENT" });
  const archiveRoot = path.join(userDataPath, "desktop-brand-rollback");
  const settingsFile = (await readdir(archiveRoot, { recursive: true })).find((name) => name.endsWith("settings.json"));
  assert.ok(settingsFile);
  const archived = JSON.parse(await readFile(path.join(archiveRoot, settingsFile), "utf8"));
  assertDormant(archived);
  assert.equal(archived.baseUrl, target.baseUrl);
  for (const [name, bytes] of Object.entries(source)) {
    const archivedFile = path.join(archiveRoot, path.dirname(settingsFile), name);
    assert.deepEqual(await readFile(archivedFile), bytes);
    const archivedStat = await stat(archivedFile);
    assert.equal(archivedStat.mtimeMs, originalStats[name].mtimeMs);
    assert.equal(archivedStat.ino, originalStats[name].ino);
  }
  // Supplying arbitrary strings still cannot replace a cleared org's state.
  await store.setDesktopBootstrapConfig({ ...target, ...dormant, requireSignin: true });
  for (const key of Object.keys(dormant)) assert.equal(store.readDesktopBootstrapConfigSync()[key], null);
  // Renderer transaction rollback forwards ONLY the shell-issued receipt.
  const restored = await store.setDesktopBootstrapConfig({
    ...target, requireSignin: true, restoreSnapshotId: previous.rollbackSnapshotId,
    brandAppName: "forged", brandLogoUrl: "http://unused.invalid/forged", brandIconUrl: null,
  });
  assertDormant(restored);
  for (const [name, bytes] of Object.entries(source)) assert.deepEqual(await readFile(path.join(userDataPath, name)), bytes);
  const disk = JSON.parse(await readFile(bootstrapPath, "utf8"));
  assertDormant(disk);
  assert.equal(Object.hasOwn(disk, "rollbackSnapshotId"), false);
  assert.equal(Object.hasOwn(disk, "restoreSnapshotId"), false);
});

test("cross-origin handoff rollback restores shell-owned snapshot and rejects forged/wrong-target receipts", async (t) => {
  const { open, userDataPath } = await fixture(t);
  const store = open();
  const previous = await store.getDesktopBootstrapConfig();
  const bytes = Buffer.from(JSON.stringify({ sourceUrl: dormant.brandIconUrl }));
  await writeFile(path.join(userDataPath, "brand-icon.json"), bytes);
  const other = { baseUrl: "https://other.example.test", apiBaseUrl: "https://other-api.example.test" };
  await store.setDesktopBootstrapConfig({ ...other, requireSignin: true });
  assertNoDormant(store.readDesktopBootstrapConfigSync());
  await assert.rejects(access(path.join(userDataPath, "brand-icon.json")), { code: "ENOENT" });
  await assert.rejects(store.setDesktopBootstrapConfig({ ...other, restoreSnapshotId: previous.rollbackSnapshotId }), /different Den target/);
  await assert.rejects(store.setDesktopBootstrapConfig({ ...target, restoreSnapshotId: "forged" }), /unavailable/);
  // Restoring dormant data cannot replace active policy with a cached value.
  const restored = await store.setDesktopBootstrapConfig({
    ...target, requireSignin: true, requireActivation: true, restoreSnapshotId: previous.rollbackSnapshotId,
  });
  assertDormant(restored);
  assert.equal(restored.requireActivation, true);
  assert.deepEqual(await readFile(path.join(userDataPath, "brand-icon.json")), bytes);
  assertDormant(open().readDesktopBootstrapConfigSync());
  // Receipts deliberately do not survive a process restart.
  await assert.rejects(open().setDesktopBootstrapConfig({ ...target, restoreSnapshotId: previous.rollbackSnapshotId }), /unavailable/);
});

for (const snapshotKind of ["prepared", "handoff"]) {
  for (const destinationKind of ["prepared", "handoff"]) {
    test(`same-target receipt with ${snapshotKind} org A rejects ${destinationKind} org B without mutations`, async (t) => {
      const { bootstrapPath, open, userDataPath } = await fixture(t);
      const original = { ...target, ...dormant, ...knownOrg(snapshotKind, "org-a"), requireSignin: true };
      await writeFile(bootstrapPath, JSON.stringify(original));
      const store = open();
      const receipt = await store.getDesktopBootstrapConfig();
      const originalCache = Buffer.from(JSON.stringify({ sourceUrl: dormant.brandIconUrl, hash: "original-org-a" }));
      await writeFile(path.join(userDataPath, "brand-icon.json"), originalCache);
      await store.setDesktopBootstrapConfig({
        ...target, ...knownOrg(destinationKind, "org-b"), requireSignin: true,
        brandAppName: null, brandLogoUrl: null, brandIconUrl: null,
      });
      const currentCache = Buffer.from(JSON.stringify({ sourceUrl: "https://unused.invalid/org-b", hash: "org-b" }));
      await writeFile(path.join(userDataPath, "brand-icon.json"), currentCache);
      const activeBefore = await readFile(bootstrapPath);
      const archivedBefore = await readArchiveFiles(userDataPath);
      await assert.rejects(store.setDesktopBootstrapConfig({
        ...target, baseUrl: `${target.baseUrl}/alias`, ...knownOrg(destinationKind, "org-b"),
        requireSignin: true, restoreSnapshotId: receipt.rollbackSnapshotId,
      }), /different organization/);
      assert.deepEqual(await readFile(bootstrapPath), activeBefore);
      assert.deepEqual(await readFile(path.join(userDataPath, "brand-icon.json")), currentCache);
      assert.deepEqual(await readArchiveFiles(userDataPath), archivedBefore);
      assert.ok(Object.values(archivedBefore).some((bytes) => bytes.equals(originalCache)));
    });
  }
}

test("older receipt retains cache through an unrelated same-target write before the target switch", async (t) => {
  const { bootstrapPath, open, userDataPath } = await fixture(t);
  const org = knownOrg("prepared", "org-a");
  await writeFile(bootstrapPath, JSON.stringify({ ...target, ...dormant, ...org, requireSignin: true }));
  const store = open();
  const a0 = await store.getDesktopBootstrapConfig();
  const originalCache = Buffer.from([137, 80, 78, 71, 12, 34]);
  const originalSidecar = Buffer.from(JSON.stringify({ sourceUrl: dormant.brandIconUrl, hash: "source-a" }));
  await writeFile(path.join(userDataPath, "brand-icon.png"), originalCache);
  await writeFile(path.join(userDataPath, "brand-icon.json"), originalSidecar);
  const a1 = await store.setDesktopBootstrapConfig({ ...target, ...org, requireSignin: false });
  assert.notEqual(a1.rollbackSnapshotId, a0.rollbackSnapshotId);
  await store.setDesktopBootstrapConfig({ baseUrl: "https://other.example.test", requireSignin: true });
  const sourceArchives = await readArchiveFiles(userDataPath);
  await assert.rejects(access(path.join(userDataPath, "brand-icon.json")), { code: "ENOENT" });
  const restored = await store.setDesktopBootstrapConfig({ ...target, ...org, requireSignin: true, restoreSnapshotId: a0.rollbackSnapshotId });
  assertDormant(restored);
  assert.deepEqual(await readFile(path.join(userDataPath, "brand-icon.png")), originalCache);
  assert.deepEqual(await readFile(path.join(userDataPath, "brand-icon.json")), originalSidecar);
  assert.deepEqual(await readArchiveFiles(userDataPath), sourceArchives);
});

test("repeated org switches and exact-config receipt aliases never rebind an original archive", async (t) => {
  const { bootstrapPath, open, userDataPath } = await fixture(t);
  const org = knownOrg("prepared", "org-a");
  const original = { ...target, ...dormant, ...org, requireSignin: true };
  await writeFile(bootstrapPath, JSON.stringify(original));
  const store = open();
  const receipt = await store.getDesktopBootstrapConfig();
  const originalCache = Buffer.from(JSON.stringify({ sourceUrl: dormant.brandIconUrl, hash: "original" }));
  await writeFile(path.join(userDataPath, "brand-icon.json"), originalCache);
  await store.setDesktopBootstrapConfig({
    ...target, ...knownOrg("prepared", "org-b"), requireSignin: true,
    brandAppName: null, brandLogoUrl: null, brandIconUrl: null,
  });
  const firstArchive = await readArchiveFiles(userDataPath);
  await store.setDesktopBootstrapConfig({ ...target, ...org, requireSignin: true, restoreSnapshotId: receipt.rollbackSnapshotId });
  // An original config copied back by an operator/older desktop resolves to
  // the same receipt. A later cache version must not replace its first archive.
  await writeFile(bootstrapPath, JSON.stringify(original));
  assert.equal((await store.getDesktopBootstrapConfig()).rollbackSnapshotId, receipt.rollbackSnapshotId);
  const laterCache = Buffer.from(JSON.stringify({ sourceUrl: dormant.brandIconUrl, hash: "later-same-org-version" }));
  await writeFile(path.join(userDataPath, "brand-icon.json"), laterCache);
  await store.setDesktopBootstrapConfig({
    ...target, ...knownOrg("handoff", "org-c"), requireSignin: true,
    brandAppName: null, brandLogoUrl: null, brandIconUrl: null,
  });
  const allArchives = await readArchiveFiles(userDataPath);
  for (const [name, bytes] of Object.entries(firstArchive)) assert.deepEqual(allArchives[name], bytes);
  assert.ok(Object.values(allArchives).some((bytes) => bytes.equals(laterCache)));
  await store.setDesktopBootstrapConfig({ ...target, ...org, requireSignin: true, restoreSnapshotId: receipt.rollbackSnapshotId });
  assert.deepEqual(await readFile(path.join(userDataPath, "brand-icon.json")), originalCache);
  assert.deepEqual(await readArchiveFiles(userDataPath), allArchives);
});

for (const difference of ["known organization", "dormant settings"]) {
  test(`cache association excludes another ${difference} version's receipt`, async (t) => {
    const { bootstrapPath, open, userDataPath } = await fixture(t);
    const org = knownOrg("prepared", "org-a");
    const original = { ...target, ...dormant, ...org, requireSignin: true };
    const unrelated = difference === "known organization"
      ? { ...original, ...knownOrg("prepared", "org-other") }
      : { ...original, brandIconUrl: "https://unused.invalid/other-version.png" };
    const store = open();
    await writeFile(bootstrapPath, JSON.stringify(unrelated));
    const otherReceipt = await store.getDesktopBootstrapConfig();
    await writeFile(bootstrapPath, JSON.stringify(original));
    await store.getDesktopBootstrapConfig();
    const originalCache = Buffer.from(JSON.stringify({ sourceUrl: dormant.brandIconUrl, hash: "source-a" }));
    await writeFile(path.join(userDataPath, "brand-icon.json"), originalCache);
    await store.setDesktopBootstrapConfig({ baseUrl: "https://other.example.test", requireSignin: true });
    const archives = await readArchiveFiles(userDataPath);
    await store.setDesktopBootstrapConfig({ ...unrelated, restoreSnapshotId: otherReceipt.rollbackSnapshotId });
    await assert.rejects(access(path.join(userDataPath, "brand-icon.json")), { code: "ENOENT" });
    assert.deepEqual(await readArchiveFiles(userDataPath), archives);
  });
}

test("unscoped MDM receipt is preserved without inferring an org owner from its URLs", async (t) => {
  const { open } = await fixture(t);
  const store = open();
  const original = await store.getDesktopBootstrapConfig();
  await store.setDesktopBootstrapConfig({ baseUrl: "https://other.example.test", requireSignin: true });
  const restored = await store.setDesktopBootstrapConfig({
    ...target, ...knownOrg("handoff", "org-a"), requireSignin: true, restoreSnapshotId: original.rollbackSnapshotId,
  });
  assertDormant(restored);
});

test("absent and explicitly null dormant fields retain their original shape", async (t) => {
  const { bootstrapPath, open } = await fixture(t);
  await writeFile(bootstrapPath, JSON.stringify({ ...target, requireSignin: true, brandLogoUrl: null }));
  await open().setDesktopBootstrapConfig({ ...target, requireSignin: false });
  const saved = JSON.parse(await readFile(bootstrapPath, "utf8"));
  assert.equal(saved.brandLogoUrl, null);
  assert.equal(Object.hasOwn(saved, "brandAppName"), false);
  assert.equal(Object.hasOwn(saved, "brandIconUrl"), false);
});
