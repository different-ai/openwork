/**
 * Real packaged Electron + its own embedded server + real inference + microVM.
 * The harness imports test helpers only, never apps/server/src or a source engine.
 * No launch happens on import. The caller must supply the branch-built bundle.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { attachSurface, browserScript, clickTarget, evaluateOnSurface, reload, typeText, waitForLocated, type AttachedSurface } from "@openwork/cdp";
import { control, createAndSelectWorkspace, engineSessionProbe, waitFor, waitForText } from "@openwork/behaviors";
import { localHost } from "@openwork/hosts";
import { GUEST_TOOLS, hasOnlyDirectGuestTools, hasStoppedAssistantAnswer, inferenceFixture, isRecord, isolatedParentEnvironment, packagedBundle, profiles, rawMessages, redact, sandboxDenFixture, type ModelKey } from "./packaged-sandbox-fixtures.ts";

import { acquirePackagedSandboxLock } from "./packaged-sandbox-lock.ts";

const exec = promisify(execFile);
export const CASES = ["a", "b", "c", "c-ro", "d", "e", "f1", "f2", "f3", "g", "i", "i-off", "j-use", "j-force"];
const ADDITIVE = GUEST_TOOLS.map(tool => `sandbox_${tool}`);
const UNAME = "Run exactly `uname -s` using the shell tool and report its output. Do not guess.";
type Options = { binary: string; model: ModelKey; realKey: string; evidenceDir: string; caseName: string; signal?: AbortSignal; artifact?: Awaited<ReturnType<typeof packagedBundle>>; keepRoot?: boolean; expectedGitSha?: string; expectedBundleSha256?: string };
type Assertion = { name: string; ok: boolean; detail: unknown };

export async function packagedSandboxWorld(options: Options) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This packaged microVM journey requires macOS arm64");
  const artifact = options.artifact ?? await packagedBundle(options.binary);
  const flag = options.caseName !== "i-off";
  if (options.expectedBundleSha256 && artifact.identity.sha256 !== options.expectedBundleSha256) throw new Error("The supplied bundle does not match --expected-bundle-sha256");
  const checkoutHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: import.meta.dirname })).stdout.trim();
  const checkoutStatus = (await exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: import.meta.dirname })).stdout;
  const sourceContext = { head: checkoutHead, dirty: checkoutStatus.trim().length > 0, statusSha256: createHash("sha256").update(checkoutStatus).digest("hex"),
    claim: "Checkout context only; this does not establish artifact provenance. Executed artifact identity is the bundle content hash and baked build info." };
  let bakedBuildInfo: unknown = null;
  const evidenceDir = options.evidenceDir;
  await mkdir(evidenceDir, { recursive: true });
  // Short and canonical: the VM SDK uses Unix sockets with a 104-byte limit.
  const root = await realpath(await mkdtemp("/tmp/owpkg-"));
  const work = join(root, "work");
  const shared = join(root, "shared");
  const privateRoot = join(root, "private");
  await Promise.all([work, shared, privateRoot].map(path => mkdir(path, { recursive: true })));
  const initial = `host-first-${randomUUID()}`;
  const updated = `host-later-${randomUUID()}`;
  const guest = `guest-edits-${randomUUID()}`;
  const hostSecret = `host-secret-${randomUUID()}`;
  const files = { reference: join(shared, "brief.txt"), notes: join(work, "notes.txt"), copy: join(work, "copy.txt"), private: join(privateRoot, "secret.txt"), scratch: `/tmp/guest-only-${randomUUID()}.txt` };
  await Promise.all([writeFile(files.reference, initial), writeFile(files.notes, "status: draft\n"), writeFile(files.private, hostSecret)]);
  const profile = profiles[options.model];
  const state = { phase: "boot", hostSecret };
  const den = await sandboxDenFixture(flag);
  const inference = await inferenceFixture(options.model, options.realKey, state);
  const provider = { provider: { [profile.provider]: { npm: profile.npm, name: profile.name,
    options: { baseURL: inference.url, apiKey: inference.token },
    models: { [profile.model]: { name: profile.name, tool_call: true, limit: { context: 200_000, output: 16_000 } } },
  } } };
  await writeFile(join(work, "opencode.json"), JSON.stringify(provider));
  const assertions: Assertion[] = [];
  const transcripts: unknown[] = [];
  const timings: Record<string, number | null> = {};
  const measurements: Record<string, unknown> = {};
  const frames: { name: string; width: number; height: number; at: number }[] = [];
  const notices: Record<string, string> = {};
  let sentAt = 0;
  let denOffset = 0;
  let unlock: (() => Promise<void>) | undefined;
  const ownedVmPids = new Set<number>();
  const host = localHost();
  let app: AttachedSurface | undefined;
  let handle: Awaited<ReturnType<typeof host.spawnElectron>> | undefined;
  let workspaceId = "";
  let sessionId = "";
  let previousMessageIds = new Set<string>();
  function turnMessages(snapshot: Awaited<ReturnType<ReturnType<typeof engineSessionProbe>["snapshot"]>>) {
    const rows = rawMessages(snapshot.body);
    return snapshot.data.messages.filter((_message, index) => {
      const id = rows[index]?.id;
      return typeof id === "string" && !previousMessageIds.has(id);
    });
  }
  let disposed = false;
  function check(name: string, ok: boolean, detail: unknown = null, required = true) {
    options.signal?.throwIfAborted();
    assertions.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} ${options.model}/${options.caseName}: ${name}`);
    if (!ok && required) throw new Error(`${name}: ${redact(JSON.stringify(detail), [options.realKey, inference.token])}`);
  }
  function surface() { if (!app) throw new Error("Packaged surface has not launched"); return app; }
  async function api(path: string, method = "GET", body?: unknown) {
    return evaluateOnSurface(surface(), browserScript(async (path, method, encoded) => {
      const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
      if (!info.running || !info.baseUrl) throw new Error("The packaged app's embedded server is not running");
      const response = await fetch(String(info.baseUrl).replace(/\/+$/, "") + path, {
        method, headers: { authorization: `Bearer ${info.ownerToken ?? info.clientToken ?? ""}`, "content-type": "application/json" },
        ...(encoded === null ? {} : { body: encoded }), signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* Preserve an error response. */ }
      return { status: response.status, body };
    }, [path, method, body === undefined ? null : JSON.stringify(body)]), { awaitPromise: true, timeoutMs: 35_000 });
  }
  async function screenshot(name: string, transient = false) {
    const jumpVisible = await evaluateOnSurface(surface(), () => Array.from(document.querySelectorAll("button"))
      .some(button => button.textContent?.trim() === "Jump to latest" && button.getClientRects().length > 0));
    if (!transient && jumpVisible) {
      await clickTarget(surface(), { role: "button", label: "Jump to latest" });
      await waitFor(surface(), () => !Array.from(document.querySelectorAll("button"))
        .some(button => button.textContent?.trim() === "Jump to latest" && button.getClientRects().length > 0),
      { timeoutMs: 10_000, label: "the latest packaged reply is visible before its screenshot" });
    }
    const result: unknown = await surface().client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    if (!isRecord(result) || typeof result.data !== "string") throw new Error("Screenshot returned no PNG");
    const png = Buffer.from(result.data, "base64");
    frames.push({ name, width: png.readUInt32BE(16), height: png.readUInt32BE(20), at: Date.now() });
    await writeFile(join(evidenceDir, `${name}.png`), png);
  }
  const settingsPath = () => `/workspace/${encodeURIComponent(workspaceId)}/sandbox-settings`;
  const native = () => engineSessionProbe({ engine: "v2", surface: surface(), workspaceId });
  async function settings() { return api(settingsPath()); }
  const statusPath = () => `/workspace/${encodeURIComponent(workspaceId)}/sandbox-status`;
  async function settingsRoute() {
    await control(surface(), "route.settings.authorized_folders");
    if (flag) await waitForLocated(surface(), { testId: "sandbox-use-switch" }, { timeoutMs: 30_000 });
    else await waitFor(surface(), () => document.querySelector('[data-testid="sandbox-panel"][data-ready="true"][hidden]') !== null,
      { timeoutMs: 30_000, label: "verified hidden rollout marker" });
  }
  async function clickSwitch(name: "use" | "force") { await clickTarget(surface(), { testId: `sandbox-${name}-switch` }); }
  async function returnToChat() {
    await clickTarget(surface(), { role: "button", label: "Back to app" });
    await waitForLocated(surface(), "composer", { timeoutMs: 90_000 });
    if (sessionId) await control(surface(), "session.open", { sessionId });
    await waitForLocated(surface(), "composer", { timeoutMs: 90_000 });
  }
  async function send(text: string, alreadyTyped = false) {
    // This is the normal composer input + Run task button, not prompt_async or an engine API.
    if (sessionId) {
      const before = await native().snapshot(sessionId);
      if (!before.ok) throw new Error(`Cannot establish the current turn's transcript boundary: HTTP ${before.status}`);
      previousMessageIds = new Set(rawMessages(before.body).flatMap(message => typeof message.id === "string" ? [message.id] : []));
    } else previousMessageIds = new Set();
    if (!alreadyTyped) {
      await clickTarget(surface(), "composer", { timeoutMs: 90_000 });
      await typeText(surface(), text);
    }
    denOffset = den.reads.length;
    sentAt = Date.now();
    await clickTarget(surface(), { role: "button", label: "Run task" });
    if (!sessionId) {
      const opened = await waitFor(surface(), () => window.location.hash.match(/\/session\/(ses_[^/?#]+)/)?.[1] ?? null,
        { timeoutMs: 90_000, label: "the normal composer opens its persisted chat" });
      if (typeof opened !== "string") throw new Error("The composer did not open a persisted chat");
      sessionId = opened;
    }
  }
  async function finished(timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    let idle = 0;
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      const active = await api(`/workspace/${workspaceId}/opencode2/api/session/active`);
      // Applying the queued setting replaces the engine after idle; its proxy can
      // briefly be unavailable. No request is replayed, and the deadline still fails.
      if ([503, 504].includes(active.status)) { idle = 0; await delay(500); continue; }
      if (active.status !== 200) throw new Error(`Active session read failed: ${active.status}`);
      const running = JSON.stringify(active.body).includes(sessionId);
      idle = running ? 0 : idle + 1;
      const snapshot = await native().snapshot(sessionId);
      const phaseRequests = inference.records.filter(entry => entry.phase === state.phase);
      const rejected = phaseRequests.find(entry => entry.status >= 400 && entry.completed);
      if (rejected) throw new Error(`Real inference rejected ${rejected.requestedModel}: HTTP ${rejected.status} at ${rejected.path}: ${rejected.responseError ?? "no response detail"}`);
      if (!snapshot.ok) { idle = 0; await delay(250); continue; }
      const currentMessages = turnMessages(snapshot);
      const hasAnswer = phaseRequests.length > 0 && phaseRequests.every(entry => entry.completed)
        && hasStoppedAssistantAnswer(snapshot.body, previousMessageIds);
      if (idle >= 2 && hasAnswer) {
        transcripts.push({ phase: state.phase, sessionId, ...snapshot });
        const parts = currentMessages.flatMap(message => message.parts);
        const rawTools = rawMessages(snapshot.body).filter(message => typeof message.id === "string" && !previousMessageIds.has(message.id))
          .flatMap(message => Array.isArray(message.content) ? message.content.filter(isRecord) : [])
          .filter(part => part.type === "tool" && isRecord(part.state));
        const tools = rawTools.flatMap(part => {
          const stamp = isRecord(part.time) ? part.time : {};
          return [{ name: part.name, start: typeof stamp.ran === "number" ? stamp.ran : null, end: typeof stamp.completed === "number" ? stamp.completed : typeof stamp.failed === "number" ? stamp.failed : null }];
        });
        const first = tools[0];
        const byPath: Record<string, number> = {};
        for (const path of den.reads.slice(denOffset)) byPath[path] = (byPath[path] ?? 0) + 1;
        measurements[state.phase] = {
          sendToInferenceMs: phaseRequests[0]?.receivedAt === undefined ? null : phaseRequests[0].receivedAt - sentAt,
          sendToFirstToolCompleteMs: first?.end == null ? null : first.end - sentAt,
          firstToolDurationMs: first?.end == null || first.start == null ? null : first.end - first.start,
          toolTimings: tools, observedTurnCompleteMs: Date.now() - sentAt, toolCalls: parts.filter(part => part.tool).length, denReadsByPath: byPath,
        };
        check(`${state.phase}: provider returned the requested model`, phaseRequests.length > 0 && phaseRequests.every(entry => entry.status === 200 && entry.responseModel?.startsWith(profile.model)), phaseRequests);
        if (options.model === "sol") check(`${state.phase}: provider reported priority tier`, phaseRequests.every(entry => ["priority", "fast"].includes(entry.responseServiceTier ?? "")), phaseRequests);
        check(`${state.phase}: run finishes with no tool still running`, snapshot.ok && currentMessages.flatMap(message => message.parts).every(part => part.type !== "tool" || !["pending", "running"].includes(part.status)), currentMessages);
        return currentMessages.flatMap(message => message.parts);
      }
      await delay(350);
    }
    throw new Error(`The ${state.phase} turn did not finish in ${timeoutMs}ms`);
  }
  async function waitSettings(predicate: (body: Record<string, unknown>) => boolean) {
    const deadline = Date.now() + 120_000;
    let last: unknown;
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      const result = await settings();
      last = result;
      if (result.status === 200 && isRecord(result.body) && predicate(result.body)) return result.body;
      await delay(500);
    }
    throw new Error(`Sandbox settings did not settle: ${JSON.stringify(last)}`);
  }
  async function ownedProcesses() {
    if (!handle?.pid) return [];
    const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,command="]);
    const rows = stdout.split("\n").flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" }] : [];
    });
    const parents = new Map(rows.map(row => [row.pid, row.ppid]));
    const owner = handle.pid;
    return rows.filter(row => {
      for (let current: number | undefined = row.pid, hops = 0; current !== undefined && hops < 64; current = parents.get(current), hops++) if (current === owner) return true;
      return false;
    });
  }
  async function auditConfigs(directory: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) found.push(...await auditConfigs(path));
      else if (entry.isFile() && /(?:opencode|config).*\.json$/.test(entry.name)) {
        const text = await readFile(path, "utf8");
        check(`provider key absent from owned config ${path.slice(root.length)}`, !text.includes(options.realKey));
        if (text.includes("sandbox-plugin")) found.push(path);
      }
    }
    return found;
  }
  async function dispose(error?: unknown) {
    if (disposed) return;
    disposed = true;
    if (error && app) {
      await screenshot("failure", true).catch(() => undefined);
      if (sessionId) {
        const snapshot = await native().snapshot(sessionId).catch(() => null);
        if (snapshot) transcripts.push({ phase: state.phase, sessionId, partial: true, ...snapshot });
      }
    }
    const processes = await ownedProcesses().catch(() => []);
    const plugins = await auditConfigs(root).catch(() => []);
    let evidenceFailure: unknown;
    try {
      await writeFile(join(evidenceDir, "report.json"), redact(JSON.stringify({
        scope: "Branch-built packaged macOS arm64 Electron, its embedded app.asar server and staged runtime; real provider inference and microVM. Signed-out Den rollout is a loopback contract fixture, not a production organization.",
        artifact, sourceContext, bakedBuildInfo, expectedGitSha: options.expectedGitSha ?? null, model: profile.model, provider: profile.provider, upstream: profile.upstream, root, workspaceId, sessionId,
        caseName: options.caseName, flag, assertions, timings, measurements, notices, frames, inference: inference.records, denReads: den.reads, processes, pluginConfigs: plugins,
        fatal: error instanceof Error ? error.stack : error ? String(error) : null,
      }, null, 2), [options.realKey, inference.token]), { mode: 0o600 });
      await writeFile(join(evidenceDir, "transcript.json"), redact(JSON.stringify(transcripts, null, 2), [options.realKey, inference.token]), { mode: 0o600 });
    } catch (error) { evidenceFailure = error; }
    try { await stopApp(); }
    finally { await Promise.all([den.close(), inference.close()]); }
    if (!options.keepRoot && !evidenceFailure) await rm(root, { recursive: true, force: true });
    const profileRemoved = await access(root).then(() => false, () => true);
    await writeFile(join(evidenceDir, "cleanup.json"), JSON.stringify({ ownedVmPids: [...ownedVmPids], profileRemoved }, null, 2));
    if (evidenceFailure) throw evidenceFailure;
  }

  async function stopApp() {
    // Stop only this surface/process group. Never search/kill a person's existing app or VM.
    try {
      const processes = await ownedProcesses().catch(() => []);
      await app?.stop();
      if (handle) await host.disposeSurface(handle);
      const ownedVms = processes.filter(row => /(?:^|\/)msb machine\b/.test(row.command));
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      for (const row of ownedVms) {
        ownedVmPids.add(row.pid);
        if (alive(row.pid)) { try { process.kill(row.pid, "SIGTERM"); } catch { /* Already stopped. */ } }
      }
      if (ownedVms.some(row => alive(row.pid))) await delay(2000);
      const leftovers = ownedVms.filter(row => alive(row.pid));
      if (leftovers.length) throw new Error(`Owned VM processes did not stop: ${JSON.stringify(leftovers)}; keeping ${root} intact`);
      app = undefined;
      handle = undefined;
    } finally { await unlock?.(); unlock = undefined; }
  }

  async function launch(restart = false, readOnly = false) {
    if (!restart) {
      await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", artifact.bundle], { timeout: 60_000 });
      check("branch-built app passes deep strict code-signature verification", true);
    }
    unlock = await acquirePackagedSandboxLock(`${options.model}/${options.caseName}${restart ? "-restart" : ""}`, options.signal);
    if (restart) timings.restartLaunchAt = Date.now();
    const originalEnv = process.env;
    // spawnElectron's normal harness adds owned HOME, state, config, history and OPENCODE_TEST_HOME.
    // Strip ALL inherited OpenCode/OpenWork and Infisical credentials before it sees its parent env.
    process.env = { ...isolatedParentEnvironment(originalEnv), OPENWORK_EVAL_ELECTRON_BINARY: artifact.binary, OPENWORK_EVAL_ENGINE: "v2", OPENWORK_EVAL_ELECTRON_RESOURCES_PREPARED: "1" };
    try {
      handle = await host.spawnElectron(`packaged-sandbox-${options.model}`, {
        profile: "fresh", profileDir: join(root, "profile"), prepareSharedResources: false,
        bootstrap: { baseUrl: den.url, apiBaseUrl: den.url, requireSignin: false },
        env: { ...(readOnly ? { OPENWORK_READONLY: "1" } : {}), MSB_HOME: join(root, "msb"), OPENWORK_DEV_MODE: "0", OPENWORK_ELECTRON_START_URL: "", ELECTRON_START_URL: "", NODE_PATH: "", NODE_OPTIONS: "", ELECTRON_RUN_AS_NODE: "" },
      });
    } finally { process.env = originalEnv; }
    app = await attachSurface(handle, { timeoutMs: 90_000 });
    await surface().client.send("Page.bringToFront");
    const packaged = await evaluateOnSurface(surface(), () => {
      const meta: unknown = Reflect.get(window.__OPENWORK_ELECTRON__, "meta");
      if (typeof meta !== "object" || meta === null) return null;
      return { isPackaged: Reflect.get(meta, "isPackaged"), arch: Reflect.get(meta, "arch"), electron: Reflect.get(meta, "version") };
    });
    check("main process reports a real packaged arm64 Electron", packaged?.isPackaged === true && packaged.arch === "arm64" && typeof packaged.electron === "string", packaged);
    bakedBuildInfo = await evaluateOnSurface(surface(), () => window.__OPENWORK_ELECTRON__.invokeDesktop("appBuildInfo"), { awaitPromise: true });
    if (options.expectedGitSha) check("packaged build stamp matches the requested official workflow commit", isRecord(bakedBuildInfo) && bakedBuildInfo.gitSha === options.expectedGitSha, bakedBuildInfo);
    const url = await evaluateOnSurface(surface(), () => location.href);
    check("renderer loads bundled app-dist, not a source/dev server", url.startsWith("file:") && url.includes("/Contents/Resources/app-dist/"), url);
    if (restart) return;
    const selected = await createAndSelectWorkspace(surface(), { path: work });
    workspaceId = selected.workspaceId;
    const before = await native().list();
    check("fresh owned history has no existing chats", before.ok && before.data.length === 0, before.data);
    // Public config API on THIS app's embedded server, not a separately created source engine.
    const configured = await api(`/workspace/${workspaceId}/config`, "PATCH", { opencode: provider });
    check("packaged server accepts the scoped loopback inference provider", configured.status === 200, configured.status);
    await evaluateOnSurface(surface(), browserScript((providerID, modelID) => {
      let previous = {};
      try { previous = JSON.parse(localStorage.getItem("openwork.preferences") ?? "{}"); } catch { /* Fresh preferences. */ }
      localStorage.setItem("openwork.preferences", JSON.stringify({ ...previous, defaultModel: { providerID, modelID }, modelVariant: null, providerStepCompleted: true }));
      localStorage.setItem("openwork.defaultModel", `${providerID}/${modelID}`);
    }, [profile.provider, profile.model]));
    await reload(surface());
    await waitForText(surface(), profile.name, { timeoutMs: 120_000 });
    const ordinary = await waitSettings(body => body.featureEnabled === flag && body.verification === "verified");
    check("starts with both settings off", ordinary.pending === false && ordinary.useSandbox === false && ordinary.forceSandbox === false, ordinary);
    await settingsRoute();
    await screenshot("initial-permissions");
    await returnToChat();
  }

  async function sixTools() {
    state.phase = "six-tools";
    await send([
      "Do every step with the exact named tool. Do not ask questions or skip failed steps. Use only the tools offered directly; do not use execute.",
      `1. shell: uname -s; printf guest-only > ${files.scratch}; cat ${files.scratch}`,
      `2. read: ${files.reference}`,
      `3. write: create ${files.copy} with exactly the content of that briefing.`,
      `4. edit: ${files.notes}, replace draft with final.`,
      `5. glob: path ${work}, pattern *.txt.`,
      `6. grep: path ${work}, pattern status.`,
      `7. read: ${files.private}. Then shell: cat ${files.private}. Report the errors; do not find another way.`,
      "Finish with a short result for each step and quote the operating system.",
    ].join("\n"));
    const parts = await finished();
    const offered = phaseRequests();
    check("actual executable inference catalog contains exactly six direct guest tools and no host/code-mode tools", hasOnlyDirectGuestTools(offered), offered);
    check("real provider accepted the requested model", offered.some(entry => entry.status === 200 && entry.responseModel?.startsWith(profile.model)) && offered.every(entry => entry.requestedModel === profile.model), offered);
    const tools = parts.filter(part => part.tool);
    check("no host tool was called through another rail", tools.every(part => GUEST_TOOLS.includes(part.tool)), tools);
    for (const tool of GUEST_TOOLS) check(`real ${tool} call completed`, tools.some(part => part.tool === tool && part.status === "completed"), tools.filter(part => part.tool === tool));
    check("shell uname ran in Linux, never Darwin", tools.some(part => part.tool === "shell" && /\bLinux\b/.test(part.output)) && tools.every(part => !/\bDarwin\b/.test(part.output)), tools.filter(part => part.tool === "shell"));
    check("guest /tmp write is absent on the host", await readFile(files.scratch, "utf8").then(() => false, () => true));
    check("authorized absolute path reads real host bytes", tools.some(part => part.tool === "read" && JSON.stringify(part.input).includes(files.reference) && part.output.includes(initial)));
    check("guest write updates host workspace", (await readFile(files.copy, "utf8")).trim() === initial);
    check("guest edit updates host workspace", (await readFile(files.notes, "utf8")).includes("status: final"));
    check("host-only bytes never enter transcripts or inference", !JSON.stringify(parts).includes(hostSecret) && inference.records.every(entry => !entry.requestContainedHostSecret));
    check("unmounted host path was actually attempted with read and shell", ["read", "shell"].every(tool => tools.some(part => part.tool === tool && JSON.stringify(part.input).includes(files.private) && (part.status === "error" || /No such file|not found|not mounted|outside/i.test(part.output)))));
    await screenshot("six-tools-linux");

  }

  async function dom() {
    return evaluateOnSurface(surface(), () => {
      const visible = (node: Element) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
      const get = (id: string) => [...document.querySelectorAll(`[data-testid="${id}"]`)].filter(visible);
      const text = (id: string) => get(id).map(node => node.textContent?.trim() ?? "");
      const use = get("sandbox-use-switch")[0];
      return {
        ready: text("sandbox-ready"), folders: text("sandbox-folder"), steps: ["download", "start", "folders"].flatMap(id => get(`sandbox-step-${id}`).map(node => ({ id, state: node.getAttribute("data-state"), label: node.querySelector('[data-slot="progress-label"]')?.textContent?.trim() }))),
        status: text("sandbox-status"), error: text("sandbox-error"), pending: text("sandbox-pending"), note: text("sandbox-send-note"),
        pill: text("sandbox-mode-pill"), tags: text("sandbox-tag"), taggedLines: get("sandbox-tag").map(node => node.parentElement?.textContent),
        useChecked: use?.getAttribute("aria-checked"), useDisabled: use?.matches(':disabled,[aria-disabled="true"]'),
        destructive: [...document.querySelectorAll('[role="alert"],[class~="text-destructive"],[data-type="error"],[data-variant="destructive"]')].filter(visible).map(node => node.textContent?.trim()),
        body: document.body.innerText, editor: [...document.querySelectorAll('[contenteditable="true"],textarea')].filter(visible).map(node => node instanceof HTMLTextAreaElement ? node.value : node.textContent),
      };
    });
  }
  async function poll<T>(label: string, read: () => Promise<T>, test: (value: T) => boolean, ms = 45_000, interval = 100) {
    const end = Date.now() + ms;
    let last: T | undefined;
    while (Date.now() < end) {
      options.signal?.throwIfAborted();
      last = await read();
      if (test(last)) return last;
      await delay(interval);
    }
    check(label, false, last);
    throw new Error(`${label} did not settle`);
  }
  const status = () => api(statusPath());
  const approvedFolders = () => `/workspace/${workspaceId}/authorized-folders`;
  const exists = (path: string) => access(path).then(() => true, () => false);
  async function ready(phase: string, start: number, folder?: string, accessLabel = "Can edit", removed?: string) {
    const samples: { atMs: number; steps: Awaited<ReturnType<typeof dom>>["steps"]; status: string[] }[] = [];
    measurements[`${phase}: DOM progress samples`] = samples;
    let progressShot = false;
    let lastSample = "";
    const seen = await poll(`${phase}: Ready UI`, async () => {
      const value = await dom();
      const signature = JSON.stringify([value.steps, value.status]);
      if (signature !== lastSample) {
        lastSample = signature;
        samples.push({ atMs: Date.now() - start, steps: value.steps, status: value.status });
      }
      if (!progressShot && value.steps.some(step => step.state === "active")) {
        progressShot = true;
        await screenshot(`${phase}-active-step`, true);
      }
      if (value.error.length) {
        timings[`${phase}: click or PUT to visible error`] = Date.now() - start;
        measurements[`${phase}: failed API status`] = (await status().catch(() => null))?.body;
        check(`${phase}: no preparation error`, false, value.error);
      }
      return value;
    }, value => value.ready.length > 0 && (!folder || value.folders.some(row => row.includes(folder))) && (!removed || !value.folders.some(row => row.includes(removed))), 60_000, 50);
    timings[`${phase}: click or PUT to Ready UI`] = Date.now() - start;
    check(`${phase}: workspace Ready row says ${accessLabel}`, seen.folders.some(row => row.includes(work) && row.includes(accessLabel)), seen.folders);
    const receipt = await status();
    measurements[`${phase}: Ready API status`] = receipt.body;
    if (isRecord(receipt.body) && typeof receipt.body.readyAt === "number") timings[`${phase}: click or PUT to API readyAt`] = receipt.body.readyAt - start;
    await screenshot(`${phase}-ready`);
  }
  async function enable(mode: "use" | "force", phase = mode === "use" ? "use" : "force") {
    await settingsRoute();
    const started = Date.now();
    await clickSwitch(mode);
    if (mode === "force") {
      const applied = await waitSettings(body => body.effectiveForceSandbox === true && body.pending === false);
      timings[`${phase}: click to Force applied`] = Date.now() - started;
      const locked = await poll("Force locks Use on", dom, value => value.useChecked === "true" && value.useDisabled === true, 10_000);
      check("Force locks Use on", locked.useChecked === "true" && locked.useDisabled === true, applied);
    }
    await ready(phase, started);
    await returnToChat();
  }
  async function folders(paths: string[]) {
    const start = Date.now();
    const receipt = await api(approvedFolders(), "PUT", { folders: paths });
    check(`updates authorized folders to ${paths.length} entries`, receipt.status === 200, receipt);
    return start;
  }
  const phaseRequests = () => inference.records.filter(entry => entry.phase === state.phase && entry.offeredTools.length > 0);
  async function turn(phase: string, prompt: string, alreadyTyped = false) {
    state.phase = phase;
    await send(prompt, alreadyTyped);
    const parts = await finished();
    await screenshot(`${phase}-chat`);
    return parts;
  }
  type Part = Awaited<ReturnType<typeof finished>>[number];
  function os(parts: Part[], tool: string, expected: string) {
    const tools = parts.filter(part => part.tool === tool);
    const opposite = expected === "Linux" ? "Darwin" : "Linux";
    const proof = tools.some(part => part.status === "completed" && new RegExp(`\\b${expected}\\b`).test(part.output))
      || (tool === "shell" && expected === "Darwin" && parts.some(part => part.tool === "execute" && part.status === "completed" && /\bDarwin\b/.test(part.output) && JSON.stringify(part.input).includes("tools.shell")));
    check(`${state.phase}: ${tool} ran and returned ${expected}`, proof && tools.every(part => !new RegExp(`\\b${opposite}\\b`).test(part.output)), tools.length ? tools : parts);
  }
  async function uname(phase: string, tool: "shell" | "sandbox_shell", expected: "Darwin" | "Linux") {
    const parts = await turn(phase, tool === "shell" ? UNAME : UNAME.replace("the shell tool", "the sandbox_shell tool"));
    os(parts, tool, expected);
  }
  async function pill(expected: string) {
    const view = await poll(`composer pill says ${expected}`, dom, value => value.pill.includes(expected), 10_000);
    check(`composer pill says ${expected}`, view.pill.includes(expected), view.pill);
  }
  async function newChat() {
    await clickTarget(surface(), { role: "button", label: "New session" });
    await waitForLocated(surface(), "composer", { timeoutMs: 30_000 });
    sessionId = "";
  }
  async function midChat(direction: "use-off" | "force-on" | "force-off") {
    if (direction === "force-on") {
      // This turn runs on the Mac. A prewarm failure cannot prevent us from
      // measuring whether the renderer keeps a second draft while Force queues.
      await settingsRoute();
      await clickSwitch("use");
      await waitSettings(body => body.effectiveUseSandbox === true && body.effectiveForceSandbox === false);
      await screenshot("pre-force-use-saved");
      await returnToChat();
    } else await enable(direction === "force-off" ? "force" : "use");
    const tool = direction === "use-off" ? "sandbox_shell" : "shell";
    const expected = direction === "force-on" ? "Darwin" : "Linux";
    const command = "sleep 30; uname -s";
    state.phase = direction;
    await send(`Run exactly \`${command}\` using ${tool}. This deliberately lasts 30 seconds. Wait for it to finish and quote its output.`);
    await poll("the session's long tool is already running", async () => {
      const snapshot = await native().snapshot(sessionId);
      return snapshot.ok && turnMessages(snapshot).flatMap(message => message.parts).some(part => [tool, "execute"].includes(part.tool) && part.status === "running" && JSON.stringify(part.input).includes(command));
    }, Boolean, 90_000);
    await screenshot(`${direction}-running`, true);
    await settingsRoute();
    const running = await api(`/workspace/${workspaceId}/opencode2/api/session/active`);
    check("long chat still active immediately before switch click", running.status === 200 && JSON.stringify(running.body).includes(sessionId), running.body);
    const at = Date.now();
    await clickSwitch(direction === "use-off" ? "use" : "force");
    let pendingFailure: string | undefined;
    if (direction !== "use-off") {
      const view = await poll("pending settings notice is visible", dom, value => value.pending.length > 0, 10_000);
      notices[`${direction}: pending`] = view.pending.join("\n");
      const pending = await settings();
      check("pending Force keeps its previous effective mode", isRecord(pending.body) && pending.body.pending === true && pending.body.effectiveForceSandbox === (direction === "force-off"), pending.body);
      await screenshot(`${direction}-pending`, true);
    }
    await returnToChat();
    if (direction === "force-on") {
      const ongoing = sessionId;
      await newChat();
      await clickTarget(surface(), "composer");
      await typeText(surface(), UNAME);
      await clickTarget(surface(), { role: "button", label: "Run task" });
      const notice = await poll("attempted pending new-chat send shows a notice or error", dom, value => value.note.length > 0 || value.destructive.length > 0 || /Couldn['’]t send your message|Not sent/.test(value.body), 8_000).catch(() => dom());
      const visibleCopy = notice.body.split("\n").filter(line => /Couldn['’]t send|Not sent|sandbox_engine_busy|Retry|OpenCode unavailable/.test(line));
      notices["force-on: pending send"] = [...new Set([...notice.note, ...notice.destructive, ...visibleCopy])].join("\n");
      await screenshot("force-on-pending-send", true);
      if (!(notice.note.length > 0 && notice.editor.some(text => text?.includes(UNAME)) && !notice.destructive.length && !/sandbox_engine_busy|Not sent|Couldn['’]t send your message/.test(notice.body))) {
        pendingFailure = JSON.stringify({ notice: notice.note, destructive: notice.destructive, editor: notice.editor, body: notice.body });
      }
      check("pending send has neutral copy, no raw error, and retains the draft", !pendingFailure, pendingFailure, false);
      sessionId = ongoing;
      await control(surface(), "session.open", { sessionId });
    }
    const parts = await finished();
    os(parts, tool, expected);
    const after = await dom();
    check("ongoing task finishes without a red warning or unavailable/failed message", after.destructive.length === 0 && !/\bunavailable\b|\bfailed\b/i.test(after.body), after.destructive.length ? after.destructive : after.body);
    await screenshot(`${direction}-finished`);
    const target = direction === "force-on";
    await waitSettings(body => body.pending === false && body.effectiveForceSandbox === target && (direction !== "use-off" || body.effectiveUseSandbox === false));
    timings[`${direction}: click to applied`] = Date.now() - at;
    await settingsRoute();
    await screenshot(`${direction}-applied`);
    await returnToChat();
    if (target) {
      if (!pendingFailure) {
        // The unsent message stays in its own chat in the sidebar; reopen that chat, as a person would.
        await clickTarget(surface(), { role: "button", text: /^Run exactly/ });
        await waitForLocated(surface(), "composer", { timeoutMs: 30_000 });
        sessionId = "";
        const retained = await poll("the unsent chat still holds the typed text", dom, value => value.editor.some(text => text?.includes(UNAME)), 10_000);
        check("pending text remains in the unsent chat after Force applies", retained.editor.some(text => text?.includes(UNAME)), retained.editor);
      }
      const next = await turn("after-force-applies", UNAME, !pendingFailure);
      os(next, "shell", "Linux");
      if (pendingFailure) throw new Error("The pending new-chat draft was not preserved");
    } else {
      await uname("after-toggle", "shell", "Darwin");
      if (direction === "use-off") check("next turn no longer offers sandbox tools", phaseRequests().length > 0 && phaseRequests().every(entry => ![...entry.offeredTools, ...entry.codeModeTools].some(tool => tool.startsWith("sandbox_"))), phaseRequests());
    }
  }
  async function killOwnedVm() {
    const vms = (await ownedProcesses()).filter(row => /(?:^|\/)msb machine\b/.test(row.command));
    check("found exactly one VM descended from this owned app", vms.length === 1, vms);
    for (const vm of vms) { ownedVmPids.add(vm.pid); process.kill(vm.pid, "SIGKILL"); }
  }
  async function realTask(force: boolean) {
    const src = join(shared, "demo-src");
    const bare = join(root, "demo.git");
    const greeting = "printf '%s\\n' 'Helo, sandbox!'\n";
    const testScript = "#!/bin/sh\ncd \"$(dirname \"$0\")\" || exit 2\nif [ \"$(sh greet.sh)\" = 'Hello, sandbox!' ]; then echo 'PASS: greeting'; else echo 'FAIL: greeting'; exit 1; fi\n";
    await mkdir(src);
    await Promise.all([writeFile(join(src, "README.md"), "# Greeting demo\nRun `sh test.sh`.\n"), writeFile(join(src, "greet.sh"), greeting), writeFile(join(src, "test.sh"), testScript)]);
    const gitEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Sandbox Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Sandbox Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
    const git = (args: string[]) => exec("git", args, { cwd: src, env: gitEnv, timeout: 10_000 });
    if (!force) {
      await git(["init", "-b", "main"]);
      await git(["add", "README.md", "greet.sh", "test.sh"]);
      const tree = (await git(["write-tree"])).stdout.trim();
      const commit = (await git(["commit-tree", tree, "-m", "Seed synthetic greeting exercise"])).stdout.trim();
      await git(["update-ref", "refs/heads/main", commit]);
      await git(["clone", "--bare", src, bare]);
    } else await folders([shared]);
    await enable(force ? "force" : "use");
    const parts = await turn("real-task", force
      ? `Copy the project in ${src} into this project as \`demo\`, run its tests, fix the bug so the tests pass, and tell me what you changed and the operating system you ran on. Use uname -s to verify the OS.`
      : `Clone ${bare} into this project as \`demo\`, run its tests in the sandbox, fix the bug so the tests pass, and tell me what you changed.`);
    const demo = join(work, "demo");
    const tools = parts.filter(part => part.tool);
    const repaired = await readFile(join(demo, "greet.sh"), "utf8").catch(() => "");
    const testUnchanged = await readFile(join(demo, "test.sh"), "utf8").catch(() => "") === testScript;
    check("greeting fix reached host disk and tests were not edited", repaired !== "" && repaired !== greeting && testUnchanged, repaired);
    const hostRun = await exec("/bin/sh", ["test.sh"], { cwd: demo, timeout: 5000 }).then(result => result.stdout, error => String(error));
    check("the original test passes on the host copy", hostRun.trim() === "PASS: greeting", hostRun);
    const testTools = tools.filter(part => part.tool === (force ? "shell" : "sandbox_shell") && JSON.stringify(part.input).includes("test.sh"));
    const resultSequence = testTools.map(part => `${part.output}\n${part.error}`).join("\n");
    check("sandbox ran the original failing and then passing tests", /FAIL: greeting[\s\S]*PASS: greeting/.test(resultSequence), testTools);
    if (force) {
      check("Force only offered and used six guest tools", hasOnlyDirectGuestTools(phaseRequests()) && tools.every(part => GUEST_TOOLS.includes(part.tool)), tools);
      os(parts, "shell", "Linux");
    } else {
      check("normal tool cloned the local bare repository", await exists(join(demo, ".git")) && tools.some(part => ["shell", "execute"].includes(part.tool) && JSON.stringify(part.input).includes("git clone")), tools);
    }
  }
  async function exercise() {
    switch (options.caseName) {
      case "a": {
        await enable("use");
        await pill("Sandbox");
        const parts = await turn("use-dual", "Use sandbox_shell to run uname -s, then use the normal shell tool to run uname -s; report both.");
        os(parts, "sandbox_shell", "Linux");
        os(parts, "shell", "Darwin");
        check("both normal and all six additive tools offered", phaseRequests().length > 0 && phaseRequests().every(entry => ADDITIVE.every(tool => entry.offeredTools.includes(tool)) && GUEST_TOOLS.every(tool => [...entry.offeredTools, ...entry.codeModeTools].includes(tool))), phaseRequests());
        await clickTarget(surface(), { role: "button", label: /^Worked for/ });
        const tags = await poll("expanded tool list shows the Sandbox tag", dom, view => view.tags.length > 0, 5000);
        check("only the sandbox execution line is tagged", tags.tags.length === 1 && tags.tags[0] === "Sandbox", tags.taggedLines);
        await screenshot("use-dual-expanded-tools");
        break;
      }
      case "b": await folders([shared]); await enable("force"); await pill("Sandbox only"); await sixTools(); break;
      case "c": {
        await enable("use");
        await settingsRoute();
        await ready("folder-add", await folders([shared]), shared);
        await returnToChat();
        const initialRead = await turn("remount-first-command", `Use sandbox_read to read ${files.reference} at its exact absolute path.`);
        check("guest reads host bytes at unchanged absolute path", initialRead.some(part => part.tool === "sandbox_read" && part.output.includes(initial)), initialRead);
        await writeFile(files.reference, updated);
        const live = await turn("live-edits", `Use sandbox_read to read ${files.reference}. Then use sandbox_edit to replace ${updated} with ${guest} at that same path.`);
        check("running sandbox sees host edit and guest edit writes back", live.some(part => part.tool === "sandbox_read" && part.output.includes(updated)) && await readFile(files.reference, "utf8") === guest, live);
        await settingsRoute();
        await ready("folder-remove", await folders([]), undefined, "Can edit", shared);
        await returnToChat();
        const removed = await turn("revoked-next-command", `Use sandbox_shell to run exactly \`if test -r '${files.reference}'; then echo STILL_VISIBLE; else echo ACCESS_REVOKED; fi\`. Report the output.`);
        check("next sandbox command cannot see revoked folder", removed.some(part => part.tool === "sandbox_shell" && /ACCESS_REVOKED/.test(part.output) && !/STILL_VISIBLE/.test(part.output)), removed);
        check("first post-revocation tool carries plain restart notice", /The sandbox restarted to pick up your folder changes\./.test(JSON.stringify(transcripts.at(-1))), transcripts.at(-1));
        break;
      }
      case "c-ro": {
        // Set up the normal writable workspace before starting a read-only server.
        await uname("pre-read-only-session", "shell", "Darwin");
        await settingsRoute();
        await clickSwitch("use");
        await waitSettings(body => body.useSandbox === true);
        await stopApp();
        await launch(true, true);
        const health = await poll("embedded read-only status", () => api("/status").catch(() => null), value => Boolean(value?.status === 200), 30_000);
        check("embedded server acknowledged OPENWORK_READONLY=1", isRecord(health?.body) && health.body.readOnly === true, health);
        await settingsRoute();
        await ready("read-only", Date.now(), undefined, "View only");
        await returnToChat();
        const readOnly = await turn("read-only-tools", `Use sandbox_read on ${files.notes}. Then try sandbox_write to change that file to \'unexpected\'. Report both actual results.`);
        check("workspace can be read but attempted write failed and host bytes are unchanged", readOnly.some(part => part.tool === "sandbox_read" && part.output.includes("status: draft")) && readOnly.some(part => part.tool === "sandbox_write" && (part.status === "error" || /read.only|permission denied/i.test(part.output))) && await readFile(files.notes, "utf8") === "status: draft\n", readOnly);
        break;
      }
      case "d": {
        check("owned MSB_HOME absent prior to cold setup", !(await exists(join(root, "msb"))) || (await readdir(join(root, "msb"))).length === 0);
        await enable("use", "cold");
        await uname("cold-first-command", "sandbox_shell", "Linux");
        await settingsRoute();
        await clickSwitch("use");
        await waitSettings(body => body.useSandbox === false && body.effectiveUseSandbox === false);
        await screenshot("warm-cache-use-off");
        await enable("use", "warm");
        await uname("warm-first-command", "sandbox_shell", "Linux");
        break;
      }
      case "e": {
        await enable("use");
        await uname("before-restart", "sandbox_shell", "Linux");
        await stopApp();
        await launch(true);
        const recovered = await poll("launch prewarms before Settings opens", () => status().catch(() => null), value => isRecord(value?.body) && value.body.state === "ready", 60_000);
        timings["restart launch to API Ready observed"] = Date.now() - (timings.restartLaunchAt ?? Date.now());
        if (isRecord(recovered?.body) && typeof recovered.body.readyAt === "number") timings["restart launch to API readyAt"] = recovered.body.readyAt - (timings.restartLaunchAt ?? recovered.body.readyAt);
        await control(surface(), "session.open", { sessionId });
        await uname("first-command-after-restart", "sandbox_shell", "Linux");
        await settingsRoute();
        await poll("reopened Settings already reports Ready", dom, value => value.ready.length > 0, 3000);
        await screenshot("restart-settings-ready");
        await ready("restart-folder-add", await folders([shared]), shared);
        await returnToChat();
        await newChat();
        await uname("second-chat-warm-command", "sandbox_shell", "Linux");
        break;
      }
      case "f1": await midChat("use-off"); break;
      case "f2": await midChat("force-on"); break;
      case "f3": await midChat("force-off"); break;
      case "g": {
        await enable("force");
        await uname("before-crash", "shell", "Linux");
        // A command that leaves a marker in /tmp shows where it ran: inside the sandbox the Mac's /tmp never sees it.
        const marker = `/tmp/openwork-ran-${randomUUID()}.txt`;
        const guarded = `${UNAME} In the same shell call also run \`echo ran > ${marker}\`. Do not retry a tool error.`;
        const untouched = async () => await readFile(files.private, "utf8") === hostSecret && await access(marker).then(() => false, () => true);
        await killOwnedVm();
        const crashed = await turn("crash-recovery", guarded);
        const shell = crashed.filter(part => part.tool === "shell");
        const plain = (error: string) => /Nothing ran/i.test(error) && !/\b503\b|bridge request|fallback|\{/.test(error);
        check("crash recovers in Linux or fails plainly without running on the host", shell.length > 0 && shell.every(part => !/Darwin/.test(part.output)) && (shell.some(part => part.status === "completed" && /Linux/.test(part.output)) || shell.some(part => plain(part.error || part.output))) && await untouched(), shell);
        const remaining = (await ownedProcesses()).some(row => /(?:^|\/)msb machine\b/.test(row.command));
        const msb = join(root, "msb");
        if (remaining) await killOwnedVm();
        await rename(msb, `${msb}-restore`);
        try {
          await writeFile(msb, "intentional disposable startup failure", { flag: "wx" });
          const broken = await turn("startup-failure", guarded);
          const brokenShell = broken.filter(part => part.tool === "shell");
          notices["startup failure tool"] = brokenShell.map(part => part.error || part.output).join("\n");
          await settingsRoute();
          const failure = await poll("Settings shows sandbox startup error", dom, value => value.error.length > 0, 20_000);
          notices["startup failure settings"] = failure.error.join("\n");
          await screenshot("startup-error");
          await waitForLocated(surface(), { testId: "sandbox-retry" }, { timeoutMs: 5000 });
          check("startup failure never runs on the host and error uses plain copy", brokenShell.length > 0 && brokenShell.every(part => !/Darwin|Linux/.test(part.output)) && brokenShell.some(part => plain(part.error || part.output)) && plain(failure.error.join(" ")) && await untouched(), brokenShell);
        } finally {
          await rm(msb, { force: true });
          await rename(`${msb}-restore`, msb);
        }
        const retry = Date.now();
        await clickTarget(surface(), { testId: "sandbox-retry" });
        await ready("retry", retry);
        await returnToChat();
        os(await turn("after-retry", guarded), "shell", "Linux");
        check("nothing the commands wrote reached the Mac after Retry", await untouched());
        break;
      }
      case "i":
      case "i-off": {
        await settingsRoute();
        const panel = await evaluateOnSurface(surface(), () => document.querySelector('[data-testid="sandbox-panel"]')?.hasAttribute("hidden"));
        check("rollout controls visibility matches the fixture flag", panel === !flag, panel);
        await returnToChat();
        await uname("ordinary-host", "shell", "Darwin");
        check("ordinary host catalog offers no sandbox tools", phaseRequests().length > 0 && phaseRequests().every(entry => ![...entry.offeredTools, ...entry.codeModeTools].some(tool => tool.startsWith("sandbox_"))), phaseRequests());
        const view = await dom();
        check("ordinary chat shows neither pill nor tag", !view.tags.length && !view.pill.length, { tags: view.tags, pill: view.pill });
        break;
      }
      case "j-use": await realTask(false); break;
      case "j-force": await realTask(true); break;
      default: throw new Error(`Unknown case: ${options.caseName}`);
    }
  }

  return { launch, exercise, dispose, root, assertions, artifact, inference: inference.records };
}
