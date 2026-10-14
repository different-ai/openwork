import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspaceStore } from "../../desktop/electron/workspace-store.mjs";
import * as desktop from "../src/app/lib/desktop";
import {
  clearDenBootstrapHandoff,
  initializeDenBootstrapConfig,
  readDenBootstrapConfig,
  readDenSettings,
  refreshDenBootstrapConfigFromShell,
  setDenBootstrapConfig,
  writeDenSettings,
} from "../src/app/lib/den";
import { exchangeHandoffAndSignIn } from "../src/app/lib/den-handoff";
import { denSessionUpdatedEvent, denSettingsChangedEvent } from "../src/app/lib/den-session-events";
import { reconcileShellBranding } from "../src/react-app/domains/cloud/desktop-config-provider";

const target = { baseUrl: "https://den.example.test", apiBaseUrl: "https://api.example.test" };
const other = { baseUrl: "https://other.example.test", apiBaseUrl: "https://other-api.example.test" };
const branding = {
  brandAppName: " Original workspace ",
  brandLogoUrl: "https://private.example.test/logo.svg?retained=1",
  brandIconUrl: "https://private.example.test/icon.png?retained=1",
};
let root: string;
let bootstrapPath: string;
let previousOverride: string | undefined;
let receipt: string | undefined;
let writes: Array<Record<string, unknown>>;
let runtimeProbe: ((url: string) => Promise<void>) | null;
let runtimeApiOverride: string | null;
let shellWriteProbe: (() => Promise<void>) | null;
let nativeCommands: string[];

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

beforeEach(async () => {
  GlobalRegistrator.register({ url: "http://localhost:5173/" });
  const scratchRoot = path.join(os.tmpdir(), "opencode");
  await mkdir(scratchRoot, { recursive: true });
  root = await mkdtemp(path.join(scratchRoot, "dormant-bootstrap-"));
  bootstrapPath = path.join(root, "desktop-bootstrap.json");
  previousOverride = process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH;
  process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH = bootstrapPath;
  writes = [];
  runtimeProbe = null;
  runtimeApiOverride = null;
  shellWriteProbe = null;
  nativeCommands = [];
  await writeFile(bootstrapPath, JSON.stringify({ ...target, ...branding, requireSignin: true }));
  const store = createWorkspaceStore({
    app: { getPath: () => root },
    defaultDenBaseUrl: target.baseUrl,
    defaultRequireSignin: false,
    forceRequireSignin: false,
  });
  const initial = await store.getDesktopBootstrapConfig();
  receipt = initial.rollbackSnapshotId;
  window.localStorage.setItem("openwork.den.activeOrgId", "org-a");
  Reflect.set(window, "__OPENWORK_ELECTRON__", {
    meta: { desktopBootstrap: initial },
    brandIcon: {
      apply: async () => {
        nativeCommands.push("__applyBrandIcon");
        return { ok: true };
      },
      getState: async () => ({ applied: false, sourceUrl: null }),
    },
    invokeDesktop: async (command: string, ...args: unknown[]) => {
      if (command === "getDesktopBootstrapConfig") return store.getDesktopBootstrapConfig();
      if (command === "setDesktopBootstrapConfig") {
        const next = args[0];
        if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error("Expected bootstrap input");
        writes.push(Object.fromEntries(Object.entries(next)));
        await shellWriteProbe?.();
        return store.setDesktopBootstrapConfig(next);
      }
      if (command === "__applyBrandAppName" || command === "__applyBrandIcon") {
        nativeCommands.push(command);
        return { ok: true };
      }
      if (command === "__getBrandIconState") return { applied: false, sourceUrl: null };
      if (command === "__fetch") {
        const url = String(args[0]);
        if (url.endsWith("/api/runtime-config")) await runtimeProbe?.(url);
        const payload = url.endsWith("/api/runtime-config")
          ? { denApiUrl: runtimeApiOverride ?? (url.startsWith(other.baseUrl) ? other.apiBaseUrl : target.apiBaseUrl) }
          : { token: "new-session", organization: { id: "org-a", slug: "org-a", name: "Workspace" }, connectEnabled: false };
        return { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
      }
      throw new Error(`Unexpected desktop command: ${command}`);
    },
  });
  await initializeDenBootstrapConfig();
});

afterEach(async () => {
  if (previousOverride === undefined) delete process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH;
  else process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH = previousOverride;
  await rm(root, { recursive: true, force: true });
  await GlobalRegistrator.unregister();
});

async function diskBootstrap() {
  return JSON.parse(await readFile(bootstrapPath, "utf8"));
}

test("real shell getter, renderer normalization and refresh retain receipt and same-origin originals", async () => {
  expect(receipt).toBeString();
  expect(readDenBootstrapConfig().rollbackSnapshotId).toBe(receipt);
  await refreshDenBootstrapConfigFromShell();
  expect(readDenBootstrapConfig().rollbackSnapshotId).toBe(receipt);
  await setDenBootstrapConfig({ ...target, requireSignin: false, brandAppName: "Ignored input" });
  expect(await diskBootstrap()).toMatchObject({ ...branding, requireSignin: false });
  expect(readDenBootstrapConfig().rollbackSnapshotId).toBeString();
  expect(writes[0]).not.toHaveProperty("restoreSnapshotId");
  expect(await diskBootstrap()).not.toHaveProperty("rollbackSnapshotId");
});

test("real shell persists enabled updates and same-org flag rollback without destroying settings", async () => {
  await setDenBootstrapConfig({ ...target, whiteLabelEnabled: true, brandAppName: "Updated workspace" });
  expect(await diskBootstrap()).toMatchObject({ ...branding, whiteLabelEnabled: true, brandAppName: "Updated workspace" });
  await setDenBootstrapConfig({ ...target, whiteLabelEnabled: false });
  expect(await diskBootstrap()).toMatchObject({ ...branding, whiteLabelEnabled: false, brandAppName: "Updated workspace" });
  expect(writes.at(-1)).not.toMatchObject({ brandAppName: null, brandLogoUrl: null, brandIconUrl: null });
  await setDenBootstrapConfig({ ...target, whiteLabelEnabled: true });
  expect(readDenBootstrapConfig()).toMatchObject({ ...branding, whiteLabelEnabled: true, brandAppName: "Updated workspace" });
});

test("real org switch archives original bootstrap and cache before all-null active clear", async () => {
  const icon = Buffer.from("original dormant icon bytes");
  await writeFile(path.join(root, "brand-icon.png"), icon);
  writeDenSettings({ ...readDenSettings(), authToken: "session", activeOrgId: "org-b" }, { persistBootstrap: false });
  for (let attempt = 0; attempt < 100 && readDenBootstrapConfig().brandAppName !== null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(writes[0]).toMatchObject({ brandAppName: null, brandLogoUrl: null, brandIconUrl: null });
  expect(await diskBootstrap()).toMatchObject({ brandAppName: null, brandLogoUrl: null, brandIconUrl: null });
  const archiveRoot = path.join(root, "desktop-brand-rollback");
  const settingsFile = (await readdir(archiveRoot, { recursive: true })).find((name) => name.endsWith("settings.json"));
  expect(settingsFile).toBeDefined();
  if (!settingsFile) throw new Error("Missing shell archive");
  expect(JSON.parse(await readFile(path.join(archiveRoot, settingsFile), "utf8"))).toMatchObject(branding);
  expect(await readFile(path.join(archiveRoot, path.dirname(settingsFile), "brand-icon.png"))).toEqual(icon);
});

test("cross-origin transaction activation failure restores originals and cache with shell-issued receipt", async () => {
  const icon = Buffer.from("preserved icon cache");
  await writeFile(path.join(root, "brand-icon.png"), icon);
  const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  const storage = window.localStorage;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: storage.getItem.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      setItem: (key: string, value: string) => {
        if (key === "openwork.den.authToken") throw new Error("activation persistence failed");
        storage.setItem(key, value);
      },
    },
  });
  try {
    const result = await exchangeHandoffAndSignIn("one-time-grant", { ...other, desktopInitiated: false });
    expect(result).toMatchObject({ ok: false, error: "activation persistence failed", grantConsumed: true });
    expect(writes).toHaveLength(2);
    expect(writes[0]).not.toHaveProperty("restoreSnapshotId");
    expect(JSON.stringify(writes[0])).not.toContain("private.example.test");
    expect(writes[1]?.restoreSnapshotId).toBe(receipt);
    expect(await diskBootstrap()).toMatchObject({ ...target, ...branding });
    expect(await readFile(path.join(root, "brand-icon.png"))).toEqual(icon);
    expect(readDenBootstrapConfig()).toMatchObject(branding);
    expect(await diskBootstrap()).not.toHaveProperty("restoreSnapshotId");
  } finally {
    if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
  }
});

test("real shell rejects forged/wrong-target receipts and ignores arbitrary branding strings", async () => {
  await expect(desktop.setDesktopBootstrapConfig({ ...target, restoreSnapshotId: "forged" }))
    .rejects.toThrow("unavailable");
  await expect(desktop.setDesktopBootstrapConfig({ ...other, restoreSnapshotId: receipt }))
    .rejects.toThrow("different Den target");
  await desktop.setDesktopBootstrapConfig({ ...target, brandAppName: "Forged name", brandLogoUrl: "https://forged.example/logo.png" });
  expect(await diskBootstrap()).toMatchObject(branding);
  const fabricated = { ...readDenBootstrapConfig(), rollbackSnapshotId: "forged" };
  await expect(setDenBootstrapConfig(target, { restoreSnapshot: fabricated })).rejects.toThrow("previously read snapshot");
  await setDenBootstrapConfig({ ...target, ...{ restoreSnapshotId: "forged" } });
  expect(writes.at(-1)).not.toHaveProperty("restoreSnapshotId");
  const trusted = readDenBootstrapConfig();
  const issuedReceipt = trusted.rollbackSnapshotId;
  trusted.rollbackSnapshotId = "mutated-after-read";
  await setDenBootstrapConfig(target, { restoreSnapshot: trusted });
  expect(writes.at(-1)?.restoreSnapshotId).toBe(issuedReceipt);
  expect(await diskBootstrap()).toMatchObject(branding);
});

test("late ON discovery cannot persist or apply after a newer OFF revision", async () => {
  const started = deferred();
  const release = deferred();
  let revision = 1;
  runtimeProbe = async () => {
    runtimeProbe = null;
    started.resolve();
    await release.promise;
  };
  const on = reconcileShellBranding({ ...branding, whiteLabelEnabled: true }, () => revision === 1);
  await started.promise;
  revision = 2;
  const off = reconcileShellBranding({ whiteLabelEnabled: false }, () => revision === 2);
  release.resolve();
  await Promise.all([on, off]);
  expect(writes).toHaveLength(1);
  expect(writes[0]?.whiteLabelEnabled).toBe(false);
  expect(await diskBootstrap()).toMatchObject({ ...branding, whiteLabelEnabled: false });
  expect(nativeCommands).toEqual(["__applyBrandAppName"]);
  expect(document.title).toBe("OpenWork");
});

test("OFF is queued even while an admitted ON shell write still leaves the renderer looking OFF", async () => {
  await setDenBootstrapConfig({ ...target, whiteLabelEnabled: false });
  writes = [];
  const started = deferred();
  const release = deferred();
  let revision = 1;
  shellWriteProbe = async () => {
    shellWriteProbe = null;
    started.resolve();
    await release.promise;
  };
  const on = reconcileShellBranding({ ...branding, whiteLabelEnabled: true }, () => revision === 1);
  await started.promise;
  expect(readDenBootstrapConfig().whiteLabelEnabled).toBe(false);
  revision = 2;
  const off = reconcileShellBranding({ whiteLabelEnabled: false }, () => revision === 2);
  release.resolve();
  await Promise.all([on, off]);
  expect(writes.map((write) => write.whiteLabelEnabled)).toEqual([true, false]);
  // The admitted ON write normalizes the effective name; OFF must retain that
  // committed source rather than restoring the pre-ON whitespace snapshot.
  expect(await diskBootstrap()).toMatchObject({ ...branding, brandAppName: branding.brandAppName.trim(), whiteLabelEnabled: false });
  expect(nativeCommands).toEqual(["__applyBrandAppName"]);
});

test("enrollment writes invalidate an in-flight branding revision before committing a new Den", async () => {
  const started = deferred();
  const release = deferred();
  runtimeProbe = async () => {
    runtimeProbe = null;
    started.resolve();
    await release.promise;
  };
  const on = setDenBootstrapConfig({ ...target, ...branding, whiteLabelEnabled: true }, { isCurrent: () => true });
  await started.promise;
  const switched = setDenBootstrapConfig({ ...other, requireSignin: true });
  release.resolve();
  await Promise.all([on, switched]);
  expect(writes).toHaveLength(1);
  expect(await diskBootstrap()).toMatchObject(other);
  expect(JSON.stringify(await diskBootstrap())).not.toContain("private.example.test");
});

test("confirmed prepared-org switch retires old enrollment records and cannot reassign B branding to A", async () => {
  const prepared = {
    orgId: "org-a", orgName: "Workspace A", orgSlug: "org-a",
    skillId: "skill-a", skillTitle: "Prepared skill", skillsDir: "/unused",
    skillPath: "/unused/SKILL.md", preparedAt: "2026-10-13T00:00:00Z",
  };
  const handoff = {
    orgId: "org-a", orgName: "Workspace A", orgSlug: "org-a",
    skillId: "skill-a", skillTitle: "Prepared skill", grant: "private-grant-a",
    denBaseUrl: target.baseUrl, createdAt: "2026-10-13T00:00:00Z",
  };
  await writeFile(bootstrapPath, JSON.stringify({ ...target, ...branding, prepared, handoff, requireSignin: true }));
  await refreshDenBootstrapConfigFromShell();
  const original = readDenBootstrapConfig();
  const icon = Buffer.from("original org A icon");
  await writeFile(path.join(root, "brand-icon.png"), icon);
  writeDenSettings({ ...readDenSettings(), authToken: "session", activeOrgId: "org-b" }, { persistBootstrap: false });
  // Intentionally capture the old bootstrap before the queued clear completes.
  await setDenBootstrapConfig({ ...original, whiteLabelEnabled: true, brandAppName: "Workspace B" }, {
    isCurrent: () => readDenSettings().activeOrgId === "org-b",
  });
  const enabled = await diskBootstrap();
  expect(enabled).toMatchObject({ brandAppName: "Workspace B", whiteLabelEnabled: true });
  expect(enabled).not.toHaveProperty("prepared");
  expect(enabled).not.toHaveProperty("handoff");
  const archiveRoot = path.join(root, "desktop-brand-rollback");
  const settingsFile = (await readdir(archiveRoot, { recursive: true })).find((name) => name.endsWith("settings.json"));
  if (!settingsFile) throw new Error("Missing original org archive");
  expect(JSON.parse(await readFile(path.join(archiveRoot, settingsFile), "utf8"))).toMatchObject({ ...branding, organizationId: "org-a" });
  expect(await readFile(path.join(archiveRoot, path.dirname(settingsFile), "brand-icon.png"))).toEqual(icon);
  writeDenSettings({ ...readDenSettings(), activeOrgName: "Renamed B" }, { persistBootstrap: false });
  // A queued barrier also proves the settings write didn't schedule a new clear.
  await setDenBootstrapConfig({ ...readDenBootstrapConfig(), whiteLabelEnabled: true }, { isCurrent: () => true });
  expect(await diskBootstrap()).toMatchObject({ brandAppName: "Workspace B", whiteLabelEnabled: true });
  // The trusted old snapshot still restores both original enrollment and bytes.
  await setDenBootstrapConfig({ ...original }, { restoreSnapshot: original });
  expect(await diskBootstrap()).toMatchObject({ ...branding, prepared, handoff });
  expect(await readFile(path.join(root, "brand-icon.png"))).toEqual(icon);
});

test("handoff retires prepared identity only on a confirmed different org, not chooser null or same-org sign-in", async () => {
  const prepared = {
    orgId: "org-a", orgName: "Workspace A", orgSlug: "org-a",
    skillId: "skill-a", skillTitle: "Prepared skill", skillsDir: "/unused",
    skillPath: "/unused/SKILL.md", preparedAt: "2026-10-13T00:00:00Z",
  };
  await setDenBootstrapConfig({ ...target, ...branding, whiteLabelEnabled: true, prepared });
  writeDenSettings({ ...readDenSettings(), activeOrgId: null }, {
    persistBootstrap: false, intentionalActiveOrgClear: true,
  });
  expect(await diskBootstrap()).toMatchObject({ ...branding, prepared });
  const sameOrg = await exchangeHandoffAndSignIn("same-org-grant", {
    ...target, desktopInitiated: false, activeOrg: { id: "org-a" },
    bootstrap: { clearHandoff: true },
  });
  expect(sameOrg.ok).toBe(true);
  expect(await diskBootstrap()).toMatchObject({ ...branding, prepared });
  const differentOrg = await exchangeHandoffAndSignIn("different-org-grant", {
    ...target, desktopInitiated: false, activeOrg: { id: "org-b" },
  });
  expect(differentOrg.ok).toBe(true);
  expect(readDenSettings().activeOrgId).toBe("org-b");
  expect(await diskBootstrap()).toMatchObject({ whiteLabelEnabled: false, brandAppName: null });
  expect(await diskBootstrap()).not.toHaveProperty("prepared");
});

function bootstrapEnrollment(orgId: string, grant: string) {
  const identity = {
    orgId, orgName: "Test workspace", orgSlug: orgId,
    skillId: "test-skill", skillTitle: "Prepared skill",
  };
  return {
    prepared: {
      ...identity, skillsDir: "/unused", skillPath: "/unused/SKILL.md",
      preparedAt: "2026-10-13T00:00:00Z",
    },
    handoff: { ...identity, grant, denBaseUrl: target.baseUrl, createdAt: "2026-10-13T00:00:00Z" },
    claimLinks: [{
      id: `${orgId}-claim`, role: "owner", token: `synthetic-${orgId}-claim`,
      url: `${target.baseUrl}/claim/${orgId}`, expiresAt: "2026-10-14T00:00:00Z",
    }],
  };
}

test("signed-in cleanup queued by the switch event cannot revive retired enrollment", async () => {
  const enrollment = bootstrapEnrollment("org-a", "synthetic-old-grant");
  await setDenBootstrapConfig({ ...target, ...branding, ...enrollment, whiteLabelEnabled: true, requireSignin: true });
  const icon = Buffer.from("archived original org icon");
  await writeFile(path.join(root, "brand-icon.png"), icon);
  const cleanups: Array<ReturnType<typeof clearDenBootstrapHandoff>> = [];
  const observedGrants: Array<string | undefined> = [];
  const consumeWhileSignedIn = () => {
    const captured = readDenBootstrapConfig();
    observedGrants.push(captured.handoff?.grant);
    cleanups.push(clearDenBootstrapHandoff(captured));
  };
  window.addEventListener(denSettingsChangedEvent, consumeWhileSignedIn);
  try {
    writeDenSettings({ ...readDenSettings(), activeOrgId: "org-b", authToken: "synthetic-session-b" }, { persistBootstrap: false });
  } finally {
    window.removeEventListener(denSettingsChangedEvent, consumeWhileSignedIn);
  }
  // The event observes A synchronously, but retirement is ahead of cleanup.
  expect(observedGrants).toEqual([enrollment.handoff.grant]);
  await Promise.all(cleanups);
  expect(writes).toHaveLength(2); // initial enrollment + retirement; cleanup is a no-op
  const current = await diskBootstrap();
  expect(current).toMatchObject({ whiteLabelEnabled: false, brandAppName: null, brandLogoUrl: null, brandIconUrl: null });
  expect(current).not.toHaveProperty("prepared");
  expect(current).not.toHaveProperty("handoff");
  expect(current).not.toHaveProperty("claimLinks");
  expect(readDenSettings()).toMatchObject({ activeOrgId: "org-b", authToken: "synthetic-session-b" });
  const archiveRoot = path.join(root, "desktop-brand-rollback");
  const settingsFile = (await readdir(archiveRoot, { recursive: true })).find((name) => name.endsWith("settings.json"));
  if (!settingsFile) throw new Error("Missing original org archive");
  expect(JSON.parse(await readFile(path.join(archiveRoot, settingsFile), "utf8"))).toMatchObject({ ...branding, organizationId: "org-a" });
  expect(await readFile(path.join(archiveRoot, path.dirname(settingsFile), "brand-icon.png"))).toEqual(icon);
});

for (const replacement of ["web target", "API target", "new grant"]) {
  test(`late authentication cleanup leaves a replacement ${replacement} untouched`, async () => {
    const enrollment = bootstrapEnrollment("org-a", "synthetic-original-grant");
    await setDenBootstrapConfig({ ...target, ...branding, ...enrollment, whiteLabelEnabled: true });
    const captured = readDenBootstrapConfig();
    const replacementTarget = replacement === "web target" ? other
      : replacement === "API target" ? { ...target, apiBaseUrl: other.apiBaseUrl } : target;
    if (replacement === "API target") runtimeApiOverride = other.apiBaseUrl;
    const replacementEnrollment = bootstrapEnrollment("org-b",
      replacement === "new grant" ? "synthetic-replacement-grant" : enrollment.handoff.grant);
    // Queue cleanup before the replacement has finished committing, just as
    // an earlier authentication promise may settle during an enrollment write.
    const committing = setDenBootstrapConfig({
      ...replacementTarget, ...replacementEnrollment, whiteLabelEnabled: true,
      brandAppName: "Current workspace", brandLogoUrl: null, brandIconUrl: null, requireSignin: false,
    });
    const cleanup = clearDenBootstrapHandoff(captured);
    await committing;
    const before = await readFile(bootstrapPath);
    const beforeWrites = writes.length;
    await cleanup;
    expect(writes).toHaveLength(beforeWrites);
    expect(await readFile(bootstrapPath)).toEqual(before);
    expect(readDenBootstrapConfig().handoff?.grant).toBe(replacementEnrollment.handoff.grant);
  });
}

test("matching grant cleanup rebases onto the latest fields without publishing or restoring the originating auth session", async () => {
  const originalEnrollment = bootstrapEnrollment("org-a", "synthetic-consumed-grant");
  await setDenBootstrapConfig({ ...target, ...branding, ...originalEnrollment, whiteLabelEnabled: true, requireSignin: true });
  const captured = readDenBootstrapConfig();
  const latestEnrollment = bootstrapEnrollment("org-b", originalEnrollment.handoff.grant);
  await setDenBootstrapConfig({
    ...target, ...latestEnrollment, whiteLabelEnabled: true, brandAppName: "Latest workspace",
    brandLogoUrl: "https://assets.example.test/latest-logo.svg", brandIconUrl: null,
    requireSignin: false, requireActivation: false,
    enterpriseActivation: { activatedAt: "2026-10-13T01:00:00Z", denBaseUrl: target.baseUrl },
  });
  writeDenSettings({ ...readDenSettings(), authToken: "synthetic-latest-session", activeOrgId: "org-b" }, { persistBootstrap: false });
  const session = readDenSettings();
  const cachedIcon = Buffer.from("retained latest workspace icon");
  await writeFile(path.join(root, "brand-icon.png"), cachedIcon);
  const expected = { ...await diskBootstrap() };
  delete expected.handoff;
  delete expected.writtenAt;
  const publications: string[] = [];
  const settingsPublished = () => publications.push("settings");
  const sessionPublished = () => publications.push("session");
  window.addEventListener(denSettingsChangedEvent, settingsPublished);
  window.addEventListener(denSessionUpdatedEvent, sessionPublished);
  try {
    let discoveries = 0;
    runtimeProbe = async () => { discoveries += 1; };
    await clearDenBootstrapHandoff(captured);
    expect(discoveries).toBe(0);
    expect(await diskBootstrap()).toMatchObject(expected);
    expect(await diskBootstrap()).not.toHaveProperty("handoff");
    expect(writes.at(-1)).not.toHaveProperty("brandAppName");
    expect(await readFile(path.join(root, "brand-icon.png"))).toEqual(cachedIcon);
    expect(readDenSettings()).toEqual(session);
    expect(publications).toEqual([]);
    const beforeWrites = writes.length;
    await clearDenBootstrapHandoff(captured); // already absent: no write/retry
    expect(writes).toHaveLength(beforeWrites);
  } finally {
    window.removeEventListener(denSettingsChangedEvent, settingsPublished);
    window.removeEventListener(denSessionUpdatedEvent, sessionPublished);
  }
});

test("unchanged scoped OFF rechecks authority in queue without writing or discarding enrollment", async () => {
  await setDenBootstrapConfig({ ...target, whiteLabelEnabled: false, requireSignin: true });
  const original = readDenBootstrapConfig();
  const originalDisk = await readFile(bootstrapPath);
  const beforeWrites = writes.length;
  let checks = 0;
  await setDenBootstrapConfig({ ...original, whiteLabelEnabled: false }, {
    isCurrent: () => { checks += 1; return true; },
  });
  expect(checks).toBeGreaterThanOrEqual(2);
  expect(writes).toHaveLength(beforeWrites);
  expect(await readFile(bootstrapPath)).toEqual(originalDisk);
  expect(readDenBootstrapConfig().rollbackSnapshotId).toBe(original.rollbackSnapshotId);
});

test("quota OFF exception rejects same-origin enrollment and security changes without clearing rollback sources", async () => {
  const prepared = {
    orgId: "org-a", orgName: "Workspace A", orgSlug: "org-a",
    skillId: "skill-a", skillTitle: "Prepared skill", skillsDir: "/unused",
    skillPath: "/unused/SKILL.md", preparedAt: "2026-10-13T00:00:00Z",
  };
  const handoff = {
    orgId: "org-a", orgName: "Workspace A", orgSlug: "org-a",
    skillId: "skill-a", skillTitle: "Prepared skill", grant: "synthetic-grant-a",
    denBaseUrl: target.baseUrl, createdAt: "2026-10-13T00:00:00Z",
  };
  const enterpriseActivation = { activatedAt: "2026-10-13T00:00:00Z", denBaseUrl: target.baseUrl };
  const claimLink = {
    id: "claim-a", role: "owner", token: "synthetic-claim-token",
    url: `${target.baseUrl}/claim/a`, expiresAt: "2026-10-14T00:00:00Z",
  };
  const claimLinks = [claimLink];
  await setDenBootstrapConfig({
    ...target, ...branding, whiteLabelEnabled: true, requireSignin: true,
    requireActivation: true, prepared, handoff, enterpriseActivation, claimLinks,
  });
  const original = readDenBootstrapConfig();
  const originalDisk = await readFile(bootstrapPath);
  const icon = Buffer.from("unchanged original org A icon");
  await writeFile(path.join(root, "brand-icon.png"), icon);
  const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  const storage = window.localStorage;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: storage.getItem.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      setItem: () => { throw new Error("storage quota exceeded"); },
    },
  });
  try {
    const beforeWrites = writes.length;
    const enrollmentChanges = [
      { prepared: { ...prepared, orgId: "org-b" } },
      { handoff: { ...handoff, orgId: "org-b" } },
      { prepared: null },
      { handoff: null },
      { requireSignin: false },
      { requireActivation: false },
      { requireActivation: undefined },
      { enterpriseActivation: { ...enterpriseActivation, activatedAt: "2026-10-13T01:00:00Z" } },
      { enterpriseActivation: null },
      { claimLinks: [{ ...claimLink, token: "synthetic-replacement-token" }] },
      { claimLinks: null },
      { baseUrl: `${target.baseUrl}/different-enrollment` },
    ];
    for (const change of enrollmentChanges) {
      await expect(setDenBootstrapConfig({ ...original, ...change, whiteLabelEnabled: false }))
        .rejects.toThrow("storage quota exceeded");
      expect(writes).toHaveLength(beforeWrites);
      expect(await readFile(bootstrapPath)).toEqual(originalDisk);
      expect(await readFile(path.join(root, "brand-icon.png"))).toEqual(icon);
    }
    // Equal cloned records (even reordered keys) are appearance-only, not an
    // enrollment change. Claim tokens must also survive the shell write.
    const { skillPath, ...preparedFields } = prepared;
    const { grant, ...handoffFields } = handoff;
    await setDenBootstrapConfig({
      ...original, whiteLabelEnabled: false,
      prepared: { skillPath, ...preparedFields },
      handoff: { grant, ...handoffFields },
      enterpriseActivation: { ...enterpriseActivation },
      claimLinks: claimLinks.map((link) => ({ ...link })),
    });
    expect(writes).toHaveLength(beforeWrites + 1);
    expect(await diskBootstrap()).toMatchObject({
      ...branding, whiteLabelEnabled: false, requireSignin: true, requireActivation: true,
      prepared, handoff, enterpriseActivation, claimLinks,
    });
    expect(await readFile(path.join(root, "brand-icon.png"))).toEqual(icon);
  } finally {
    if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
  }
});

test("storage quota failure permits same-target OFF but still rejects destructive clear and target switch", async () => {
  await setDenBootstrapConfig({ ...target, ...branding, whiteLabelEnabled: true });
  const icon = Buffer.from("retained icon bytes");
  await writeFile(path.join(root, "brand-icon.png"), icon);
  const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  const storage = window.localStorage;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: storage.getItem.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      setItem: () => { throw new Error("storage quota exceeded"); },
    },
  });
  try {
    await reconcileShellBranding({ whiteLabelEnabled: false }, () => true);
    expect(await diskBootstrap()).toMatchObject({ ...branding, whiteLabelEnabled: false });
    expect(await readFile(path.join(root, "brand-icon.png"))).toEqual(icon);
    expect(nativeCommands).toEqual(["__applyBrandAppName"]);
    const offWrites = writes.length;
    await expect(setDenBootstrapConfig({ ...target, whiteLabelEnabled: true })).rejects.toThrow("storage quota exceeded");
    await expect(setDenBootstrapConfig({ ...other, whiteLabelEnabled: false })).rejects.toThrow("storage quota exceeded");
    await expect(setDenBootstrapConfig({ ...target, whiteLabelEnabled: false }, {
      clearDormantBranding: true, organizationId: "org-b",
    })).rejects.toThrow("storage quota exceeded");
    expect(writes).toHaveLength(offWrites);
    expect(await diskBootstrap()).toMatchObject({ ...target, ...branding, whiteLabelEnabled: false });
  } finally {
    if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
  }
});
