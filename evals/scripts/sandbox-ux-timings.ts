/** macOS arm64, owned Electron/MSB roots. From the worktree: infisical run --env dev --silent -- pnpm exec node evals/scripts/sandbox-ux-timings.ts --app /tmp/owbefore/OpenWork.app --evidence-dir <dir> --scenarios a,b,c. See the before report for the signed-in matrix. */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import { attachSurface, browserScript, clickTarget, evaluateOnSurface, reload, typeText, waitForLocated, type AttachedSurface } from "@openwork/cdp";
import { control, createAndSelectWorkspace, engineSessionProbe, signInDesktopAs, waitFor, waitForText } from "@openwork/behaviors";
import { localHost } from "@openwork/hosts";
import { hasStoppedAssistantAnswer, isRecord, isolatedParentEnvironment, packagedBundle, profiles, rawMessages, redact } from "../worlds/packaged-sandbox-fixtures.ts";
import { timedInference, uxDenFixture, uxScriptedInference } from "../worlds/sandbox-ux-fixtures.ts";

import { acquirePermissionsMachine, installPermissionsFetchTrace, permissionsDescendants, pollPermissions } from "../worlds/sandbox-ux-permissions.ts";

const exec = promisify(execFile);
const { values } = parseArgs({ options: {
  app: { type: "string" }, ui: { type: "string", default: "legacy" }, "evidence-dir": { type: "string" },
  flag: { type: "string", default: "on" }, scenarios: { type: "string", default: "a,b,c" },
  "signed-in": { type: "boolean" }, workspaces: { type: "string", default: "1" }, "den-latency-ms": { type: "string" },
  "scripted-model": { type: "boolean" }, "verification-trace": { type: "boolean" }, "verification-fault": { type: "boolean" },
  model: { type: "string", default: "fable" }, "den-delay-ms": { type: "string", default: "0" }, "den-offline": { type: "boolean" },
} });
function selectUi(selection: string | undefined) {
  if (selection !== "legacy" && selection !== "modes") throw new Error("--ui must be legacy or modes");
  return {
    route: "route.settings.authorized_folders", heading: "Authorized folders", add: "Add folder",
    modes: selection === "modes", toggle: selection === "modes" ? "sandbox-use-switch" : "host-execution-switch", back: "Back to app", send: "Run task", newChat: "session.create_task",
  };
}
const ui = selectUi(values.ui);
const groups = new Set(values.scenarios?.split(","));
if ([...groups].some(group => !["a", "b", "c", "pending", "crash", "direct", "turns"].includes(group))) throw new Error("--scenarios: a=permissions/API, b=commands/remount/toggle, c=active-toggle/crash/restart; use pending, crash, direct, or turns for individual probes");
if (!values.app || !values["evidence-dir"] || !values.app.endsWith(".app")) throw new Error("Supply --app <bundle.app> and --evidence-dir <directory>");
const model = values.model;
if (model !== "fable" && model !== "sol") throw new Error("--model must be fable or sol");
const flag = values.flag === "on";
if (!flag && values.flag !== "off") throw new Error("--flag must be on or off");
const offline = Boolean(values["den-offline"]);
const signedIn = Boolean(values["signed-in"]);
const count = Number(values.workspaces);
if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw new Error("--workspaces must be an integer from 1–100");
const latencies = (values["den-latency-ms"] ?? values["den-delay-ms"] ?? "0").split(",").map(Number);
const denDelay = latencies[0] ?? 0;
const expectsSwitch = flag && !offline;
if (latencies.length > 1 && !signedIn) throw new Error("Use one latency per run for the signed-out fixture");
const matrix = signedIn || values["den-latency-ms"] !== undefined || count !== 1 || groups.has("direct");
if (signedIn && offline) throw new Error("--signed-in cannot bootstrap against offline Den");
if (ui.modes && [...groups].some(group => !["a", "direct"].includes(group))) throw new Error("--ui modes only supports Permissions scenarios (a,direct)");
if (latencies.some(ms => !Number.isFinite(ms) || ms < 0)) throw new Error("--den-delay-ms must be nonnegative");
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Requires macOS arm64");
const scripted = Boolean(values["scripted-model"]);
const liveProfile = profiles[model];
const profile = scripted ? { ...liveProfile, model: "witness", provider: "sandbox-ux-proof", npm: "@ai-sdk/openai-compatible", name: "Sandbox UX witness" } : liveProfile;
const key = process.env[profile.keyEnv]?.trim();
if (!key && !scripted && [...groups].some(group => ["b", "c", "pending", "crash", "turns"].includes(group))) throw new Error(`${profile.keyEnv} is required for ${model}`);
const originalEnv = isolatedParentEnvironment(process.env);
const bundle = await realpath(values.app);
if (bundle === "/Applications/OpenWork.app") throw new Error("Use an isolated copy; never launch the installed OpenWork app");
const binDir = join(bundle, "Contents/MacOS");
const [binary, ...extra] = await readdir(binDir);
if (!binary || extra.length) throw new Error("Expected one executable in the app bundle");
const artifact = await packagedBundle(join(binDir, binary));
await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", artifact.bundle], { timeout: 60_000 });
const plist = join(artifact.bundle, "Contents/Info.plist");
const evidence = resolve(values["evidence-dir"]);
await mkdir(evidence, { recursive: true });
const environment = {
  date: new Date().toISOString(), appVersion: (await exec("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", plist])).stdout.trim(),
  bundleVersion: (await exec("/usr/bin/plutil", ["-extract", "CFBundleVersion", "raw", plist])).stdout.trim(),
  bundleSha256: artifact.identity.sha256, macOS: (await exec("/usr/bin/sw_vers", ["-productVersion"])).stdout.trim(), model: profile.model, scripted,
  ui: values.ui, flag, offline, denDelay, latencies, signedIn, requestedWorkspaces: count, scenarios: [...groups],
};
const root = await realpath(await mkdtemp("/tmp/owux-"));
const work = join(root, "work");
const shared = join(root, "shared");
await Promise.all([mkdir(work), mkdir(shared)]);
// A signed-in scenario owns its Den for the entire fixture lifetime, including relaunches.
const releaseDenMachine = signedIn ? await acquirePermissionsMachine(`${values.ui} signed-in N=${count} +${latencies.join(",")} / local Den`) : undefined;
const signed = signedIn ? await (await import("../worlds/sandbox-ux-signed-in.ts")).uxSignedInDen(flag).catch(async error => {
  try { await rm(root, { recursive: true, force: true }); } finally { await releaseDenMachine?.(); }
  throw error;
}) : null;
const den = signed ?? await uxDenFixture(flag, denDelay, offline, matrix);
const state = { phase: "boot", hostSecret: "unused-ux-canary" };
const inference = await (scripted ? uxScriptedInference() : timedInference(model, key ?? "no-inference-permissions-only", state)).catch(async error => {
  try { await den.close(); await rm(root, { recursive: true, force: true }); } finally { await releaseDenMachine?.(); }
  throw error;
});
const provider = { provider: { [profile.provider]: { npm: profile.npm, name: profile.name,
  options: { baseURL: inference.url, apiKey: inference.token },
  models: { [profile.model]: { name: profile.name, tool_call: true, limit: { context: 200_000, output: 16_000 } } },
} } };
await writeFile(join(work, "opencode.json"), JSON.stringify(provider), { mode: 0o600 }).catch(async error => {
  try { await Promise.all([den.close(), inference.close()]); } finally { await releaseDenMachine?.(); }
  throw error;
});
const secrets = [key, inference.token, signed?.member.token].filter(value => typeof value === "string");
const safe = (value: unknown) => redact(value instanceof Error ? value.message : String(value), secrets);
const timings: { scenario: string; metric: string; ms: number | null; detail: unknown }[] = [];
const events: { scenario: string; kind: string; text: string; ms: number | null; screenshot: string | null }[] = [];
const transcript: unknown[] = [];
const host = localHost();
let releaseMachine: (() => Promise<void>) | undefined;
let permissionsFailed = false;
let app: AttachedSurface | undefined;
let handle: Awaited<ReturnType<typeof host.spawnElectron>> | undefined;
let workspaceId = "";
let sessionId = "";
let modelReady = false;
const surface = () => { if (!app) throw new Error("No owned renderer"); return app; };
const metric = (scenario: string, metric: string, ms: number | null, detail: unknown = null) => timings.push({ scenario, metric, ms: ms === null ? null : Math.round(ms * 10) / 10, detail });
const event = (scenario: string, kind: string, text: string, ms: number | null = null, screenshot: string | null = null) => events.push({ scenario, kind, text: safe(text), ms, screenshot });
const elapsed = (since: number) => performance.now() - since;
async function json(name: string, value: unknown) {
  await writeFile(join(evidence, `${name}.json`), redact(JSON.stringify(value, null, 2), secrets) + "\n", { mode: 0o600 });
}
async function shot(name: string) {
  const result: unknown = await surface().client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  if (!isRecord(result) || typeof result.data !== "string") throw new Error("Screenshot returned no image");
  const filename = `${name}.png`;
  await writeFile(join(evidence, filename), Buffer.from(result.data, "base64"));
  return filename;
}
async function view(scenario: string, suffix: string, start: number, full = false) {
  const at = elapsed(start);
  const text = await evaluateOnSurface(surface(), () => document.body.innerText.trim());
  const filename = await shot(`${scenario}-${suffix}`);
  const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
  for (const line of new Set(lines.filter(line => /loading|checking|preparing|error|failed|recreat|starting|thinking|unable|running|denied|finish|retry|saved|unavailable|not found/i.test(line)))) event(scenario, "visible", line, at, filename);
  if (full) event(scenario, "screen-text", text, at, filename);
  metric(scenario, `screenshot-${suffix}`, at, filename);
  return text;
}
async function step(name: string, fn: () => Promise<unknown>) {
  const start = performance.now();
  console.log(`START ${name}`);
  try { await fn(); console.log(`DONE ${name}`); return true; }
  catch (error) {
    const file = await shot(`${name}-failure`).catch(() => null);
    event(name, "failure", safe(error), elapsed(start), file);
    console.error(`FAIL ${name}: ${safe(error)}`);
    return false;
  } finally {
    await Promise.all([json("timings", { environment, timings }), json("events", events), json("transcripts", transcript), json("requests", { den: den.requests, inference: inference.records, arrivals: inference.arrivals })]);
  }
}
function requestCounts(requests: { path: string }[]) {
  const byPath: Record<string, number> = {};
  for (const { path } of requests) byPath[path] = (byPath[path] ?? 0) + 1;
  return { total: requests.length, byPath };
}
const path = (name: string) => `/workspace/${encodeURIComponent(workspaceId)}/${name}`;
async function api(endpoint: string, method = "GET", body?: unknown) {
  return evaluateOnSurface(surface(), browserScript(async (endpoint, method, encoded) => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!info.running || !info.baseUrl || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(info.baseUrl).hostname)) throw new Error("Expected owned loopback embedded server");
    const response = await fetch(String(info.baseUrl).replace(/\/+$/, "") + endpoint, {
      method, headers: { authorization: `Bearer ${info.ownerToken ?? info.clientToken ?? ""}`, "content-type": "application/json" },
      ...(encoded === null ? {} : { body: encoded }), signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* Keep plain text. */ }
    return { status: response.status, body, serverTiming: response.headers.get("server-timing") };
  }, [endpoint, method, body === undefined ? null : JSON.stringify(body)]), { awaitPromise: true, timeoutMs: 20_000 });
}
async function ownedVms() {
  const owner = handle?.pid;
  if (!owner) return [];
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,command="]);
  const rows = stdout.split("\n").flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), parent: Number(m[2]), cmd: m[3] ?? "" }] : [];
  });
  const parents = new Map(rows.map(row => [row.pid, row.parent]));
  return rows.filter(row => {
    if (!/(?:^|\/)msb machine\b/.test(row.cmd)) return false;
    for (let p: number | undefined = row.parent, i = 0; p !== undefined && i < 64; i++, p = parents.get(p)) if (p === owner) return true;
    return false;
  });
}
async function stopApp() {
  try { await disposeApp(); }
  finally {
    await releaseMachine?.();
    releaseMachine = undefined;
  }
}
async function disposeApp() {
  const owned = await ownedVms();
  await app?.stop();
  app = undefined;
  if (handle) await host.disposeSurface(handle);
  handle = undefined;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const vm of owned) if (alive(vm.pid)) { try { process.kill(vm.pid, "SIGTERM"); } catch { /* Already exited. */ } }
  if (owned.some(vm => alive(vm.pid))) await delay(1500);
  const leftover = owned.filter(vm => alive(vm.pid));
  if (leftover.length) throw new Error(`Owned VM remains after cleanup: ${leftover.map(vm => vm.pid).join(", ")}`);
}
async function launch(name: string, restart = false, direct = false) {
  releaseMachine = releaseDenMachine ? undefined : await acquirePermissionsMachine(`${values.ui} ${signedIn ? "signed-in" : "signed-out"} N=${count} ${name}`);
  const t = performance.now();
  const parent = process.env;
  process.env = { ...originalEnv, OPENWORK_EVAL_ELECTRON_BINARY: artifact.binary, OPENWORK_EVAL_ENGINE: "v2", OPENWORK_EVAL_ELECTRON_RESOURCES_PREPARED: "1" };
  try {
    handle = await host.spawnElectron(`sandbox-ux-${model}`, {
      profile: "fresh", profileDir: join(root, "profile"), prepareSharedResources: false,
      bootstrap: { baseUrl: den.url, apiBaseUrl: den.url, requireSignin: false },
      env: { MSB_HOME: join(root, "msb"), OPENWORK_DEV_MODE: "0", OPENWORK_ELECTRON_START_URL: "", ELECTRON_START_URL: "", NODE_PATH: "", NODE_OPTIONS: "", ELECTRON_RUN_AS_NODE: "" },
    });
  } finally { process.env = parent; }
  metric(name, "spawn-cdp-ready", elapsed(t));
  app = await attachSurface(handle, { timeoutMs: 90_000 });
  metric(name, "renderer-attached", elapsed(t));
  await surface().client.send("Page.bringToFront");
  const renderer = await evaluateOnSurface(surface(), () => ({ url: location.href, packaged: Reflect.get(window.__OPENWORK_ELECTRON__, "meta")?.isPackaged }));
  if (!renderer.packaged || !renderer.url.startsWith("file:") || !renderer.url.includes("/Contents/Resources/app-dist/")) throw new Error("Renderer is not the packaged app");
  if (direct) return;
  if (signed && !restart) {
    await signInDesktopAs(surface(), { webUrl: den.url, apiUrl: den.url }, signed.member);
    const bootstrapped = await evaluateOnSurface(surface(), () => window.__openwork?.slice?.("route")?.workspaces ?? []);
    metric(name, "signed-in-workspaces-before-arrangement", null, bootstrapped.map(ws => ({ id: ws.id, path: ws.path })));
  }
  if (restart && matrix) {
    // Do not create a replacement if the persisted active workspace has not hydrated yet.
    await waitFor(surface(), browserScript(id => window.__openwork?.slice?.("route")?.workspaces?.some(ws => ws.id === id) ?? false, [workspaceId]), {
      timeoutMs: 90_000, label: "persisted timing workspace restored",
    });
    await evaluateOnSurface(surface(), browserScript(id => { location.hash = `/workspace/${id}/session`; }, [workspaceId]));
  } else {
    const selected = await createAndSelectWorkspace(surface(), { path: work });
    if (restart && workspaceId !== selected.workspaceId) throw new Error("Relaunch did not select the same workspace");
    workspaceId = selected.workspaceId;
  }
  sessionId = "";
  metric(name, "workspace-selected", elapsed(t), workspaceId);
  await waitForLocated(surface(), "composer", { timeoutMs: 45_000 });
  metric(name, "composer-visible", elapsed(t));
  await view(name, "composer", t);
}
async function openPermissions() { await control(surface(), ui.route); }
async function back() {
  await clickTarget(surface(), { role: "button", label: ui.back }, { timeoutMs: 10_000 });
  await waitForLocated(surface(), "composer", { timeoutMs: 25_000 });
  if (sessionId) await control(surface(), "session.open", { sessionId });
}
async function permissions(name: string, expectSwitch: boolean, direct = false) {
  const descendantsBefore = await permissionsDescendants(handle?.pid);
  const detailed = Boolean(values["verification-trace"] || values["verification-fault"]);
  const controlledFault = Boolean(ui.modes && values["verification-fault"] && signed && name.startsWith("permissions-warm"));
  if (controlledFault) signed?.setOrgFault(true);
  const trace = detailed ? await installPermissionsFetchTrace(surface()) : null;
  const denFrom = den.requests.length;
  const poll = pollPermissions(surface(), { modes: ui.modes, expectSwitch, captureMs: matrix ? 15_250 : 8_250, limitMs: 20_000 });
  // Keep the passive fetch witness open for the full observation window separately
  // from the TTI sampler, including if the renderer throttles background timers.
  const verificationWindow = detailed ? delay(20_000) : Promise.resolve();
  const t = performance.now();
  const photos = (matrix ? [100, 300, 1000, 3000, 8000, 15000] : [100, 300, 1000, 3000, 8000]).map(ms => delay(ms).then(() => view(name, `${ms}ms`, t, true)).catch(error => event(name, "capture-error", safe(error))));
  const descendants = delay(5000).then(() => permissionsDescendants(handle?.pid));
  const [result, route, processResult] = await Promise.allSettled([poll, direct ? evaluateOnSurface(surface(), () => { location.hash = "/settings/permissions"; }) : openPermissions(), descendants, ...photos]);
  await verificationWindow;
  if (result.status !== "fulfilled") {
    if (trace) await json(`${name}-passive-fetch`, { rendererFetch: await trace(), den: den.requests.slice(denFrom).map(entry => ({ ...entry })) });
    throw result.reason;
  }
  const { marks, notices, resources, t: pageStart, epoch: pageEpoch, performanceMarks } = result.value;
  for (const id of ["heading-visible", "folders-ready", "add-enabled", "sandbox-ready", "switch-visible", "switch-enabled", "force-enabled", "tti"]) metric(name, id, marks[id] ?? null, marks[id] === undefined ? "not observed in probe window" : "renderer performance.now; ~25ms poll");
  for (const [text, windows] of Object.entries(notices)) for (const window of windows) event(name, "panel-poll", text, window.start);
  const denUntil = den.requests.length;
  const rendererFetch = await trace?.();
  if (controlledFault) {
    signed?.setOrgFault(false);
    const retryOffset = den.requests.length;
    const retryTrace = await installPermissionsFetchTrace(surface());
    const retryAt = performance.now();
    const clicked = await evaluateOnSurface(surface(), () => {
      const retry = [...document.querySelectorAll('[data-testid="sandbox-panel"] button')].find(el => el.textContent?.trim() === "Retry" && el.parentElement?.innerText?.includes("Couldn't check your organization's settings."));
      if (!(retry instanceof HTMLButtonElement) || retry.disabled) return false;
      retry.click();
      return true;
    });
    if (clicked) await delay(1200);
    const note = await evaluateOnSurface(surface(), () => document.querySelector('[data-testid="sandbox-panel"]')?.textContent?.includes("Couldn't check your organization's settings.") ?? false);
    const retryRenderer = await retryTrace();
    await json(`${name}-retry`, { clicked, stillUnavailable: note, retryAt, rendererFetch: retryRenderer, den: den.requests.slice(retryOffset).map(row => ({ ...row })) });
    await shot(`${name}-after-org-retry`);
  }
  const openRequests = den.requests.slice(denFrom, denUntil).map(entry => ({ ...entry }));
  const descendantsAfter = processResult.status === "fulfilled" ? processResult.value : [];
  const sandboxProcesses = [...descendantsBefore, ...descendantsAfter].filter(row => row.executable === "msb");
  const headerProbes = ui.modes ? await Promise.all(["sandbox-settings", "sandbox-status", "authorized-folders"].map(async endpoint => {
    if (resources.some(row => row.name.endsWith(`/${endpoint}`) && row.serverTiming.length > 0)) return { endpoint, source: "resource" };
    return api(path(endpoint)).then(({ status, serverTiming }) => ({ endpoint, status, serverTiming, source: "post-open read" }), error => ({ endpoint, error: safe(error) }));
  })) : [];
  await json(name + "-resources", { pageStart, pageEpoch, marks, notices, resources, performanceMarks, den: openRequests, denCounts: requestCounts(openRequests), descendantsBefore, descendantsAfter, sandboxProcesses, headerProbes, rendererFetch });
  if (route.status === "rejected") throw route.reason;
  if (processResult.status === "rejected") throw processResult.reason;
  if (sandboxProcesses.length) throw new Error("Opening Permissions observed a sandbox process");
  if (marks.tti === undefined) throw new Error("Permissions did not become interactive within 20 s");
  if (expectSwitch !== (marks["switch-visible"] !== undefined)) throw new Error(`Expected switch ${expectSwitch ? "present" : "absent"}`);
}

async function settingsApi() {
  for (const endpoint of ["sandbox-settings", "authorized-folders"]) {
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      const res = await api(path(endpoint));
      if (res.status !== 200) throw new Error(`${endpoint} HTTP ${res.status}`);
      samples.push(elapsed(t));
    }
    const sorted = [...samples].sort((a, b) => a - b);
    for (const { index, label } of [{ index: 0, label: "min" }, { index: 2, label: "median" }, { index: 4, label: "max" }]) {
      metric("settings-api", `${endpoint}-${label}`, sorted[index] ?? null, { samples });
    }
  }
  await view("settings-api", "chat", performance.now());
}
async function useModel() {
  if (modelReady) return;
  const result = await api(path("config"), "PATCH", { opencode: provider });
  if (result.status !== 200) throw new Error(`Provider config HTTP ${result.status}`);
  await evaluateOnSurface(surface(), browserScript((providerID, modelID) => {
    let previous = {};
    try { previous = JSON.parse(localStorage.getItem("openwork.preferences") ?? "{}"); } catch { /* Fresh profile. */ }
    localStorage.setItem("openwork.preferences", JSON.stringify({ ...previous, defaultModel: { providerID, modelID }, modelVariant: null, providerStepCompleted: true }));
    localStorage.setItem("openwork.defaultModel", `${providerID}/${modelID}`);
  }, [profile.provider, profile.model]));
  await reload(surface());
  await waitForText(surface(), profile.name, { timeoutMs: 90_000 });
  await waitForLocated(surface(), "composer", { timeoutMs: 40_000 });
  modelReady = true;
}
const probe = () => engineSessionProbe({ surface: surface(), workspaceId, engine: "v2" });
async function begin(name: string, prompt: string) {
  await useModel();
  if (sessionId) await control(surface(), "session.open", { sessionId });
  const prev = sessionId ? await probe().snapshot(sessionId) : null;
  if (prev && !prev.ok) throw new Error(`Prior transcript HTTP ${prev.status}`);
  const ids = new Set(prev ? rawMessages(prev.body).flatMap(row => typeof row.id === "string" ? [row.id] : []) : []);
  await clickTarget(surface(), "composer", { timeoutMs: 20_000 });
  await typeText(surface(), prompt);
  state.phase = name;
  const denFrom = den.requests.length;
  const t = performance.now();
  await clickTarget(surface(), { role: "button", label: ui.send }, { timeoutMs: 10_000 });
  if (!sessionId) {
    const current = await waitFor(surface(), () => location.hash.match(/\/session\/(ses_[^/?#]+)/)?.[1] ?? null, { timeoutMs: 25_000, label: "persisted chat" });
    if (typeof current !== "string") throw new Error("Missing session ID from composer send");
    sessionId = current;
  }
  return { id: sessionId, ids, t, denFrom };
}
type Turn = Awaited<ReturnType<typeof begin>>;
function newRows(body: unknown, turn: Turn) {
  return rawMessages(body).filter(row => typeof row.id !== "string" || !turn.ids.has(row.id));
}
function rawParts(rows: ReturnType<typeof newRows>) {
  return rows.flatMap(row => (Array.isArray(row.content) ? row.content : Array.isArray(row.parts) ? row.parts : []).filter(isRecord));
}
function stamp(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string") { const parsed = Date.parse(value); if (Number.isFinite(parsed)) return parsed; }
  return null;
}
function duration(part: Record<string, unknown>) {
  const state = isRecord(part.state) ? part.state : {};
  const time = isRecord(state.time) ? state.time : isRecord(part.time) ? part.time : {};
  const start = stamp(time.ran ?? time.start ?? state.startedAt);
  const end = stamp(time.completed ?? time.end ?? state.completedAt ?? state.endedAt);
  return start === null || end === null || end < start ? null : end - start;
}
async function watch(name: string, turn: Turn, tool: string, onRunning?: () => Promise<void>) {
  let appeared = false;
  let running: number | null = null;
  let terminal: Awaited<ReturnType<ReturnType<typeof probe>["snapshot"]>>["data"]["messages"][number]["parts"][number] | undefined;
  let body: unknown;
  let notified = false;
  let finishedAt: number | null = null;
  let action: Promise<void> | undefined;
  try {
    while (elapsed(turn.t) < 240_000) {
      const rejected = inference.records.find(entry => entry.phase === name && entry.status >= 400);
      if (rejected) throw new Error(`Inference HTTP ${rejected.status}: ${rejected.responseError ?? "no response detail"}`);
      const snap = await probe().snapshot(turn.id);
      if (!snap.ok) { await delay(250); continue; }
      body = snap.body;
      const raw = rawMessages(body);
      const parts = snap.data.messages.flatMap((message, index) => {
        const id = raw[index]?.id;
        return typeof id === "string" && !turn.ids.has(id) ? message.parts : [];
      });
      const now = elapsed(turn.t);
      const matching = parts.filter(part => part.tool === tool);
      if (!appeared && matching[0]) {
        appeared = true;
        metric(name, "send-to-tool-appears", now, { firstObserved: matching[0].status });
      }
      if (matching.some(part => part.status === "running") && running === null) {
        running = now;
        metric(name, "send-to-tool-running", now);
      }
      if (onRunning && running !== null && !notified) {
        notified = true;
        action = onRunning().catch(error => { event(name, "active-action-error", safe(error), elapsed(turn.t)); });
      }
      if (!terminal) {
        terminal = matching.find(part => ["completed", "error"].includes(part.status));
        if (terminal) {
          const rawTool = rawParts(newRows(body, turn)).find(part => (part.id ?? part.callID) === terminal?.callId);
          metric(name, "send-to-tool-terminal", now, terminal);
          metric(name, "tool-observed-running-to-terminal", running === null ? null : now - running, { status: terminal.status });
          metric(name, "tool-engine-duration", rawTool ? duration(rawTool) : null, { state: rawTool?.state });
          if (terminal.error) event(name, "tool-error", terminal.error, now);
        }
      }
      if (hasStoppedAssistantAnswer(body, turn.ids)) { finishedAt = now; break; }
      await delay(80);
    }
  } finally {
    await action;
    const first = inference.arrivals.find(entry => entry.phase === name);
    metric(name, "send-to-inference", first ? first.ms - turn.t : null, "validated request recorded by loopback inference fixture");
    metric(name, "total-turn", finishedAt, "first terminal assistant answer in native transcript");
    const denRequests = den.requests.slice(turn.denFrom);
    metric(name, "den-requests", null, requestCounts(denRequests));
    transcript.push({ scenario: name, session: turn.id, body });
  }
  if (finishedAt === null) throw new Error("No terminal assistant answer within 240s");
  if (!terminal) throw new Error(`No terminal ${tool} tool part in the turn`);
  return terminal;
}
const uname = (tool: string) => `Use the ${tool} tool to run exactly: uname -s. Then reply with only its output.`;
async function command(name: string, tool: string, prompt: string, verify: (part: Awaited<ReturnType<typeof watch>>) => boolean, screenshots = false) {
  const turn = await begin(name, prompt);
  const captures = screenshots ? [2000, 6000].map(ms => delay(Math.max(0, ms - elapsed(turn.t))).then(() => view(name, `${ms}ms`, turn.t, true)).catch(error => event(name, "capture-error", safe(error)))) : [];
  const part = await watch(name, turn, tool).finally(() => Promise.all(captures));
  await view(name, "result", turn.t, true);
  if (!verify(part)) throw new Error(`Unexpected ${tool} result (${part.status}): ${part.error || part.output}`);
  return part;
}
const isLinux = (part: Awaited<ReturnType<typeof watch>>) => part.status === "completed" && /\bLinux\b/.test(part.output) && !/\bDarwin\b/.test(part.output);
const isDarwin = (part: Awaited<ReturnType<typeof watch>>) => part.status === "completed" && /\bDarwin\b/.test(part.output);
async function waitSetting(allow: boolean, pending: boolean) {
  const t = performance.now();
  let last: unknown;
  while (elapsed(t) < 60_000) {
    const res = await api(path("sandbox-settings"));
    last = res.body;
    if (res.status === 200 && isRecord(last) && last.pending === pending && last.allowHostExecution === allow && last.effectiveAllowHostExecution === (pending ? !allow : allow)) return last;
    await delay(125);
  }
  throw new Error(`Settings not applied: ${JSON.stringify(last)}`);
}
async function activateToggle() {
  await evaluateOnSurface(surface(), browserScript(id => {
    const button = document.querySelector(`[data-testid="${id}"]`);
    if (!(button instanceof HTMLElement) || button.matches(':disabled,[aria-disabled="true"]')) throw new Error("Host execution switch not enabled");
    button.click();
  }, [ui.toggle]));
}
async function switchMode(name: string, allow: boolean) {
  await openPermissions();
  await waitForLocated(surface(), { testId: ui.toggle }, { timeoutMs: 15_000 });
  const checked = await evaluateOnSurface(surface(), browserScript(id => document.querySelector(`[data-testid="${id}"]`)?.getAttribute("aria-checked"), [ui.toggle]));
  if (checked === String(allow)) { await waitSetting(allow, false); await back(); return; }
  const t = performance.now();
  await activateToggle();
  const applied = await waitSetting(allow, false);
  metric(name, "click-to-effective", elapsed(t), applied);
  await view(name, "applied", t, true);
  await back();
}
async function remount() {
  const file = join(shared, "proof.txt");
  await writeFile(file, "mounted-ux-proof\n");
  const before = await api(path("authorized-folders"));
  const existing = isRecord(before.body) && Array.isArray(before.body.folders) ? before.body.folders : [];
  for (const { name, add } of [{ name: "remount-add", add: true }, { name: "remount-remove", add: false }]) {
    await step(name, async () => {
      const t = performance.now();
      const result = await api(path("authorized-folders"), "PUT", { folders: add ? [...existing, shared] : existing });
      metric(name, "put-folders", elapsed(t), { status: result.status });
      if (result.status !== 200) throw new Error(`Folder update HTTP ${result.status}: ${JSON.stringify(result.body)}`);
      await command(name, "sandbox_shell", `Use sandbox_shell to run exactly: cat ${file}. Do not retry or use another tool. Report its precise output or error.`,
        part => add ? part.output.includes("mounted-ux-proof") : !part.output.includes("mounted-ux-proof") && (part.status === "error" || /No such file|not found|not mounted|denied/i.test(part.output)));
    });
  }
}
async function midChat() {
  const name = "mid-chat-toggle";
  const turn = await begin(name, "Use shell to run exactly: sleep 25; uname -s. Wait for it to finish and reply only with its output.");
  let toggleAt: number | undefined;
  let pendingAt: number | undefined;
  const result = await watch(name, turn, "shell", async () => {
    await openPermissions();
    await waitForLocated(surface(), { testId: ui.toggle }, { timeoutMs: 12_000 });
    toggleAt = performance.now();
    await activateToggle();
    const pending = await api(path("sandbox-settings"));
    if (!isRecord(pending.body) || pending.body.pending !== true) throw new Error(`Pending not observed: ${JSON.stringify(pending.body)}`);
    pendingAt = elapsed(toggleAt);
    metric(name, "click-to-pending", pendingAt, pending.body);
    await view(name, "pending", toggleAt, true);
    await back();
    try {
      await clickTarget(surface(), { role: "button", label: "New session" }, { timeoutMs: 2500 });
      await view(name, "new-chat-open", toggleAt, true);
      const moved = await evaluateOnSurface(surface(), browserScript(id => !location.hash.includes(id), [turn.id]));
      if (!moved) throw new Error("New session click did not leave the running task");
      await clickTarget(surface(), "composer", { timeoutMs: 2500 });
      await typeText(surface(), "Reply with exactly: pending-check.");
      await clickTarget(surface(), { role: "button", label: ui.send }, { timeoutMs: 2500 });
    } catch (error) { event(name, "new-chat-send", safe(error), elapsed(toggleAt)); }
    await view(name, "new-chat-send", toggleAt, true);
    await delay(1200);
    await view(name, "new-chat-after-send", toggleAt, true);
  });
  if (toggleAt === undefined || pendingAt === undefined) throw new Error("Active toggle did not demonstrate pending state");
  const applied = await waitSetting(true, false);
  metric(name, "click-to-effective", elapsed(toggleAt), applied);
  if (!isLinux(result)) throw new Error(`Ongoing shell did not finish in Linux: ${result.error || result.output}`);
  sessionId = turn.id;
}

let cleanupOk = false;
try {
  if (!await step("app-start", () => launch("app-start"))) throw new Error("Cannot continue without owned packaged app");
  const scenario = !flag ? "flag-off" : offline ? "permissions-den-offline" : denDelay ? "permissions-den-slow" : "permissions-cold";
  if (matrix) {
    if (!await step("arrange-workspaces", async () => {
      for (let i = 1; i < count; i++) {
        const folder = join(root, `work-${i + 1}`);
        await mkdir(folder);
        await createAndSelectWorkspace(surface(), { path: folder });
      }
      await createAndSelectWorkspace(surface(), { path: work });
      const workspaces = await evaluateOnSurface(surface(), () => window.__openwork?.slice?.("route")?.workspaces?.map(ws => ({ id: ws.id, path: ws.path })) ?? []);
      metric("arrange-workspaces", "observed-workspace-count", null, workspaces);
    })) throw new Error("Workspace arrangement failed");
    for (const latency of latencies) {
      signed?.setLatency(latency);
      const name = (value: string) => latencies.length === 1 ? value : `${value}-l${latency}`;
      if (groups.has("a")) {
        const cold = name("permissions-cold");
        const ok = await step(cold, async () => { await stopApp(); await launch(name("app-start-cold"), true); await permissions(cold, expectsSwitch); });
        if (!ok) permissionsFailed = true;
        if (ok) {
          const warm = name("permissions-warm");
          if (!await step(warm, async () => { await back(); await permissions(warm, expectsSwitch); await back(); })) permissionsFailed = true;
        }
      }
      if (groups.has("direct")) {
        const direct = name("permissions-direct");
        if (!await step(direct, async () => { await stopApp(); await launch(name("app-start-direct"), true, true); await permissions(direct, expectsSwitch, true); })) permissionsFailed = true;
      }
    }
    if (groups.has("turns")) {
      signed?.setLatency(150);
      if ((groups.has("a") || groups.has("direct")) && !await step("turns-app-start", async () => { await stopApp(); await launch("turns-app-start", true); })) throw new Error("Could not reach composer for signed-in turns");
      await step("signed-in-host-turn", () => command("signed-in-host-turn", "shell", uname("shell"), isDarwin));
      await step("signed-in-sandbox-turn", () => command("signed-in-sandbox-turn", "sandbox_shell", uname("sandbox_shell"), isLinux));
    }
  } else if (groups.has("a")) {
    if (!await step(scenario, () => permissions(scenario, expectsSwitch))) permissionsFailed = true;
    await step("return-from-permissions", back);
    if (flag && !offline && !denDelay) {
      await step("permissions-warm", async () => { await permissions("permissions-warm", true); await back(); });
      await step("permissions-after-restart", async () => { await stopApp(); await launch("app-start-restart", true); await permissions("permissions-after-restart", true); await back(); });
      await step("settings-api", settingsApi);
    }
  }
  if (groups.has("b") && !offline) {
    if (flag) {
      await step("use-first-command", () => command("use-first-command", "sandbox_shell", uname("sandbox_shell"), isLinux, true));
      await step("use-second-command", () => command("use-second-command", "sandbox_shell", uname("sandbox_shell"), isLinux, true));
      // Same in-chat host control required by the additive sequence.
      await step("use-host-still-works", () => command("use-host-still-works", "shell", uname("shell"), isDarwin));
      // Fresh chat matching the flag-off comparison; background traffic is retained in evidence.
      await step("host-flag-on", async () => {
        await useModel();
        await control(surface(), ui.newChat);
        sessionId = "";
        await command("host-flag-on", "shell", uname("shell"), isDarwin);
      });
      await remount();
      if (await step("force-switch", () => switchMode("force-switch", false))) {
        await step("force-first-command", () => command("force-first-command", "shell", uname("shell"), isLinux));
        await step("force-second-command", () => command("force-second-command", "shell", uname("shell"), isLinux));
      }
    } else await step("host-flag-off", () => command("host-flag-off", "shell", uname("shell"), isDarwin));
  }
  if (["c", "pending", "crash"].some(group => groups.has(group)) && flag && !offline) {
    if (!await step("prepare-model", useModel)) throw new Error("Model must be configured before disabling host execution");
  }
  if ((groups.has("c") || groups.has("pending")) && flag && !offline) {
    if (groups.has("pending") && !groups.has("b")) {
      if (!await step("pending-warmup", () => command("pending-warmup", "sandbox_shell", uname("sandbox_shell"), isLinux))) throw new Error("Pending capture requires one successful sandbox turn");
    }
    if (await step("mid-chat-setup", () => switchMode("mid-chat-setup", false))) await step("mid-chat-toggle", midChat);
  }
  if ((groups.has("c") || groups.has("crash")) && flag && !offline) {
    if (groups.has("crash") && !groups.has("pending") && !groups.has("b") && !groups.has("c")) {
      if (!await step("crash-warmup", () => command("crash-warmup", "sandbox_shell", uname("sandbox_shell"), isLinux))) throw new Error("Crash capture requires one successful sandbox turn");
    }
    if ((groups.has("c") && groups.has("crash")) || groups.has("pending")) {
      await step("restart-before-crash", async () => { await stopApp(); await launch("restart-before-crash", true); });
    }
    if (await step("crash-setup", () => switchMode("crash-setup", false))) await step("crash", async () => {
      await command("crash-baseline", "shell", uname("shell"), isLinux);
      const vms = await ownedVms();
      if (!vms.length) throw new Error("No msb machine process descended from this launch");
      for (const vm of vms) process.kill(vm.pid, "SIGKILL");
      event("crash", "injection", `SIGKILL sent to ${vms.length} owned VM process(es)`);
      const t = performance.now();
      const verify = (part: Awaited<ReturnType<typeof watch>>) => !/\bDarwin\b/.test(part.output) && (isLinux(part) || part.status === "error");
      for (const attempt of ["crash", "crash-retry"]) {
        try { await command(attempt, "shell", uname("shell"), verify); }
        catch (error) {
          await view(attempt, "failure", t, true);
          event(attempt, "failure", safe(error), elapsed(t), `${attempt}-failure.png`);
        }
      }
    });
    await step("app-restart-command", async () => {
      await stopApp();
      await launch("app-start-command-restart", true);
      await waitSetting(false, false);
      await command("app-restart-command", "shell", uname("shell"), isLinux);
    });
  }
} catch (error) {
  event("run", "fatal", safe(error));
  process.exitCode = 1;
} finally {
  if (permissionsFailed) process.exitCode = 1;
  try {
    await stopApp();
    cleanupOk = true;
  } catch (error) {
    event("cleanup", "failure", safe(error));
    process.exitCode = 1;
  }
  try {
    const log = await readFile(join(root, "profile/electron.log"), "utf8").catch(() => "");
    // Keep only redacted diagnostic lines. Full desktop logs can include server credentials.
    const diagnostics = log.split("\n").filter(line => /sandbox|msb/i.test(line) && /error|fail/i.test(line) && !/bearer|token|password|api.key|secret/i.test(line));
    await Promise.all([json("timings", { environment, timings }), json("events", events), json("transcripts", transcript), json("requests", { den: den.requests, inference: inference.records, arrivals: inference.arrivals }), json("diagnostics", { diagnostics, cleanupOk })]);
  } finally {
    try {
      await Promise.all([den.close(), inference.close()]);
      if (cleanupOk) await rm(root, { recursive: true, force: true });
    } finally { await releaseDenMachine?.(); }
  }
}
