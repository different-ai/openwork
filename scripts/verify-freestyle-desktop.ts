import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import { client, execChecked, launchPreview, type PreviewSession } from "../packages/freestyle/src/index.ts";

const sha = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("Usage: node scripts/verify-freestyle-desktop.ts <full-pushed-sha>");

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const inspect = `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { inspectDesktop } from "/opt/openwork-preview/desktop-state.mjs";
import { desktopProfileEnvironment } from "/opt/openwork-preview/desktop.mjs";
import { verifyBrowserHandoff } from "/opt/openwork-preview/browser-health.mjs";
const root = "/opt/openwork-preview";
const services = JSON.parse(readFileSync(root + "/services.json", "utf8"));
assert.deepEqual(services, { desktop: "http://127.0.0.1:6080" });
assert.deepEqual(Object.keys(JSON.parse(readFileSync(root + "/outputs.json", "utf8"))), ["desktopStatus"]);
for (const name of ["mysqld", "redis-server"]) {
  let absent = false;
  try { execFileSync("pgrep", ["-x", name], { stdio: "ignore" }); }
  catch (error) { if (error.status === 1) absent = true; else throw error; }
  assert.equal(absent, true);
}
for (const name of ["xfwm4", "xfce4-panel"]) execFileSync("pgrep", ["-x", name], { stdio: "ignore" });
const state = await inspectDesktop();
await verifyBrowserHandoff();
await verifyBrowserHandoff({ launcher: "exo-open", args: ["--launch", "WebBrowser"] });
await verifyBrowserHandoff({ launcher: "gio", args: ["launch", "/usr/share/applications/google-chrome.desktop"] });
const profile = JSON.parse(readFileSync(root + "/desktop/profile.json", "utf8"));
await verifyBrowserHandoff({ env: desktopProfileEnvironment(profile) });
const { attachSurface, evaluate, browserScript } = await import("/workspace/evals/packages/cdp/src/index.ts");
const surface = await attachSurface({ name: "browser-handoff", kind: "electron", hostKind: "local", cdpUrl: "http://127.0.0.1:9825" });
try {
  await verifyBrowserHandoff({ launcher: "Electron shell.openExternal", openUrl: (url) => evaluate(surface, browserScript((href) => window.__OPENWORK_ELECTRON__.shell.openExternal(href), [url])) });
} finally { await surface.stop(); }
console.log(JSON.stringify({ ...state, desktopOnlyServices: true, browserHandoff: true, electronBrowserHandoff: true, xfce: true }));
`;

async function verify() {
  const api = client();
  const sessions: PreviewSession[] = [];
  const launches: { launchMs: number }[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const start = performance.now();
      const session = await launchPreview({ gitSha: sha, world: "desktop", lifetimeMinutes: 10 }, api);
      sessions.push(session);
      launches.push({ launchMs: Math.round(performance.now() - start) });
      assert.equal(session.url, session.outputs.desktopUrl.value);
      assert.deepEqual(Object.keys(session.outputs).sort(), ["desktopStatus", "desktopUrl", "previewCookie"]);
      const viewer = new URL("/vnc.html", session.url);
      const opened = await fetch(viewer, { headers: { cookie: session.outputs.previewCookie.value }, signal: AbortSignal.timeout(30_000) });
      assert.equal(opened.status, 200);
      assert.match(await opened.text(), /noVNC/);
      const denied = await fetch(viewer, { signal: AbortSignal.timeout(30_000) });
      assert.equal(denied.status, 401);
      await denied.body?.cancel();
      const vm = api.vms.ref(session.id);
      assert.equal((await vm.fs.readTextFile("/opt/openwork-preview/source-sha")).trim(), sha);
      assert.equal((await execChecked(vm, "git -C /workspace rev-parse HEAD")).trim(), sha);
      assert.equal((await vm.fs.readTextFile("/opt/openwork-preview/desktop/status")).trim(), "ready-signed-out");
      await vm.fs.writeTextFile("/tmp/verify-freestyle-desktop.mjs", inspect, { mode: 0o600 });
      const state: unknown = JSON.parse((await execChecked(vm, "node /tmp/verify-freestyle-desktop.mjs", 180_000)).trim());
      assert.ok(record(state));
      for (const key of ["ready", "signedOut", "firstRun", "emptyLocalWorkspace", "noConversations", "noDemoAccount", "noProvisionedModel", "ordinaryDefaultModel", "noNativeCloudSession", "noNativeProviderCredentials", "isolatedProfile", "noBootstrap", "desktopOnlyServices", "browserHandoff", "electronBrowserHandoff", "xfce"]) assert.equal(state[key], true);
    }
    const [first, second] = sessions;
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.url, second.url);
    assert.notEqual(first.outputs.previewCookie.value, second.outputs.previewCookie.value);
    assert.equal(first.snapshotId, second.snapshotId);
    const crossClone = await fetch(new URL("/vnc.html", second.url), {
      headers: { cookie: first.outputs.previewCookie.value }, signal: AbortSignal.timeout(30_000),
    });
    assert.equal(crossClone.status, 401);
    await crossClone.body?.cancel();
    const firstVm = api.vms.ref(first.id);
    const secondVm = api.vms.ref(second.id);
    const profile: unknown = JSON.parse(await firstVm.fs.readTextFile("/opt/openwork-preview/desktop/profile.json"));
    assert.ok(record(profile) && typeof profile.userDataPath === "string" && profile.userDataPath.startsWith("/opt/openwork-preview/desktop/openwork-test-profile-"));
    const marker = `${profile.userDataPath}/clone-isolation-probe`;
    await firstVm.fs.writeTextFile(marker, "synthetic-isolation-marker");
    assert.equal(await secondVm.fs.exists(marker), false);
  } finally {
    const cleanup = await Promise.allSettled(sessions.map((session) => api.vms.delete(session.id)));
    if (cleanup.some((result) => result.status === "rejected")) throw new Error("Test clone cleanup failed; provider TTL remains bounded");
  }
  const proof = {
    gitSha: sha, world: "desktop", measuredAt: new Date().toISOString(), launches,
    scope: "Two independent canonical desktop launches; no Den or seeded world. Launch timing includes authorized viewer readiness, not browser rendering.",
    exactSource: true, signedOut: true, firstRun: true, emptyLocalWorkspace: true, noConversations: true,
    noDemoAccount: true, noProvisionedModel: true, ordinaryDefaultModel: true, noNativeCloudSession: true, noNativeProviderCredentials: true,
    initialState: "Stock automatic local workspace and ordinary product default model retained; no cloud account, provisioned providers, or conversations.",
    noBootstrap: true, desktopOnlyServices: true, browserHandoff: true, electronBrowserHandoff: true, xfce: true, independentProfilesAndAccess: true,
    viewerAuthorized200: true, viewerUnauthorized401: true, crossCloneDenied401: true, clonesDeleted: true,
  };
  await writeFile("freestyle-desktop-launch-proof.json", JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `\n## Desktop-only snapshot verification\n\nCommit: \`${sha}\`\n\nVerified two isolated Electron/XFCE clones, pristine signed-out state with the stock automatic local workspace and ordinary default model, no conversations/cloud account/provisioned providers/bootstrap, desktop-only services, viewer 200/401 and cross-clone denial. Both test clones deleted. No access URLs or credentials are included.\n`);
}

void verify().catch(() => {
  console.error("Desktop-only verification failed; no private guest output is emitted. Cleanup was attempted for every returned clone; failed launches also use canonical cleanup and provider TTL.");
  process.exitCode = 1;
});
