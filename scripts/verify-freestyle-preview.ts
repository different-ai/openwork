import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import { client, execChecked, launchPreview, type PreviewSession } from "../packages/freestyle/src/index.ts";

// Run only from the reviewed, pinned controller after CI prewarming. Never emit
// access URLs, credentials, or arbitrary guest output into public CI artifacts.
const sha = process.argv[2];
if (!sha) throw new Error("Usage: node scripts/verify-freestyle-preview.ts <full-pushed-sha>");
const api = client();
const sessions: PreviewSession[] = [];
const launches: { launchMs: number; repeatHtmlMs: number }[] = [];
async function json(session: PreviewSession, service: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(new URL(path, session.outputs[service].value), {
    ...init, headers: { cookie: session.outputs.previewCookie.value, ...init.headers },
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, "Restored service request must succeed");
  return response.json();
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
try {
  for (let index = 0; index < 2; index++) {
    const start = performance.now();
    const session = await launchPreview({ gitSha: sha, world: "acme-web", lifetimeMinutes: 10 }, api);
    const launchMs = Math.round(performance.now() - start);
    sessions.push(session);
    const appStart = performance.now();
    const page = await fetch(new URL("/", session.url), {
      headers: { cookie: session.outputs.previewCookie.value }, signal: AbortSignal.timeout(30_000),
    });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /OpenWork/);
    launches.push({ launchMs, repeatHtmlMs: Math.round(performance.now() - appStart) });
  }
  const [first, second] = sessions;
  assert.notEqual(first.id, second.id);
  assert.ok(first.url !== second.url, "Clones need separate URLs");
  assert.ok(first.outputs.previewCookie.value !== second.outputs.previewCookie.value, "Clones need separate credentials");
  assert.equal(first.snapshotId, second.snapshotId);
  const firstVm = api.vms.ref(first.id);
  const secondVm = api.vms.ref(second.id);
  const marker = await firstVm.fs.readTextFile("/opt/openwork-preview/ready-world");
  assert.equal(await secondVm.fs.readTextFile("/opt/openwork-preview/ready-world"), marker);
  const warm: unknown = JSON.parse(marker);
  assert.ok(record(warm) && typeof warm.pid === "number" && Number.isSafeInteger(warm.pid) && warm.pid > 0);
  // Same process PID and start tick in both clones, with the original warm marker.
  const processState = `test -d /proc/${warm.pid} && awk '{print $22}' /proc/${warm.pid}/stat`;
  assert.equal(await execChecked(firstVm, processState), await execChecked(secondVm, processState));
  await execChecked(firstVm, "mysql -uroot -ppassword -e 'CREATE DATABASE preview_isolation_probe'");
  assert.equal((await execChecked(secondVm, "mysql -uroot -ppassword -N -e \"SHOW DATABASES LIKE 'preview_isolation_probe'\"")).trim(), "");
  const outputs = first.outputs;
  const capabilities = await json(first, "denApi", `/v1/admin/organizations/${outputs.orgId.value}/capabilities`, {
    headers: { authorization: `Bearer ${outputs.denToken.value}` },
  });
  assert.ok(record(capabilities) && record(capabilities.capabilities) && capabilities.capabilities.gatewayDashboard === true);
  await json(first, "denApi", "/api/auth/sign-in/email", {
    method: "POST", headers: { "content-type": "application/json", origin: new URL(outputs.denWeb.value).origin },
    body: JSON.stringify({ email: outputs.alexEmail.value, password: outputs.alexPassword.value }),
  });
  const headers = { authorization: `Bearer ${outputs.openworkToken.value}`, "content-type": "application/json" };
  const workspaces = await json(first, "openworkUrl", "/workspaces", { headers });
  assert.ok(record(workspaces) && Array.isArray(workspaces.items));
  const workspace = workspaces.items.find(record);
  assert.ok(workspace && typeof workspace.id === "string");
  const base = `/workspace/${encodeURIComponent(workspace.id)}/opencode`;
  const conversation = await json(first, "openworkUrl", `${base}/session`, {
    method: "POST", headers, body: JSON.stringify({ title: "Resumed gateway verification" }),
  });
  assert.ok(record(conversation) && typeof conversation.id === "string");
  const response = await json(first, "openworkUrl", `${base}/session/${conversation.id}/message`, {
    method: "POST", headers,
    body: JSON.stringify({ model: { providerID: outputs.providerId.value, modelID: outputs.modelId.value }, parts: [{ type: "text", text: "Verify the restored gateway." }] }),
  });
  assert.ok(record(response) && Array.isArray(response.parts));
  assert.ok(response.parts.some((part: unknown) => record(part) && part.type === "text" && part.text === "Acme AI Gateway is working."));
  // The real desktop app renders into the display the access-checked viewer streams.
  assert.ok(outputs.desktopUrl, "ACME snapshots must link the desktop viewer");
  const viewer = new URL("/vnc.html", outputs.desktopUrl.value);
  const opened = await fetch(viewer, { headers: { cookie: outputs.previewCookie.value }, signal: AbortSignal.timeout(30_000) });
  assert.equal(opened.status, 200);
  assert.match(await opened.text(), /noVNC/);
  assert.equal((await fetch(viewer, { signal: AbortSignal.timeout(30_000) })).status, 401, "The viewer requires this sandbox's access");
  const desktopStart = performance.now();
  let desktop = "";
  while (performance.now() - desktopStart < 240_000) {
    desktop = (await execChecked(firstVm, "cat /opt/openwork-preview/desktop/status")).trim();
    if (desktop !== "starting") break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  assert.ok(desktop === "ready" || desktop === "ready-signed-out", "The desktop app must finish booting");
  const desktopSignedIn = desktop === "ready";
  const desktopReadyMs = Math.round(performance.now() - desktopStart);
  // A full desktop session, not a bare app window.
  await execChecked(firstVm, "pgrep -x xfwm4 >/dev/null && pgrep -x xfce4-panel >/dev/null");
  const proof = {
    gitSha: sha, world: "acme-web", measuredAt: new Date().toISOString(), launches,
    scope: "Controller launch includes first authorized app HTML readiness, followed by a repeat HTML fetch. Excludes reviewer HTTP overhead and browser rendering; not a click-to-usable benchmark.",
    restoredRunningProcess: true, independentDatabases: true, independentUrlsAndCredentials: true,
    demoSignIn: true, gatewayDashboardEnabled: true, freshGatewayReply: true, desktopViewer: true, desktopReadyMs, desktopSignedIn,
  };
  await writeFile("freestyle-launch-proof.json", JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `\n## Live ACME snapshot verification\n\nCommit: \`${sha}\`\n\n| Clone | Link and first app HTML ready | Repeat HTML fetch |\n| --- | --- | --- |\n${launches.map((item, index) => `| ${index + 1} | ${(item.launchMs / 1000).toFixed(2)} s | ${(item.repeatHtmlMs / 1000).toFixed(2)} s |`).join("\n")}\n\n${proof.scope}\n\nVerified: restored running process, independent databases and access, demo sign-in, enabled AI Gateway dashboard, a fresh reply through the resumed gateway, and the real desktop app behind the access-checked viewer (${desktopSignedIn ? "signed in as the demo owner" : "signed out"}, ready ${(desktopReadyMs / 1000).toFixed(1)} s after checks began). Test VMs are deleted after verification.\n`);
} finally {
  await Promise.all(sessions.map((session) => api.vms.delete(session.id)));
}
