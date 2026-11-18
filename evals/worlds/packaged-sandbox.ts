/**
 * Real packaged Electron + its own embedded server + real inference + microVM.
 * The harness imports test helpers only, never apps/server/src or a source engine.
 * No launch happens on import. The caller must supply the branch-built bundle.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { attachSurface, browserScript, clickTarget, evaluateOnSurface, reload, typeText, waitForLocated, type AttachedSurface } from "@openwork/cdp";
import { control, createAndSelectWorkspace, engineSessionProbe, waitFor, waitForText } from "@openwork/behaviors";
import { localHost } from "@openwork/hosts";
import { GUEST_TOOLS, hasOnlyDirectGuestTools, hasStoppedAssistantAnswer, inferenceFixture, isRecord, isolatedParentEnvironment, packagedBundle, profiles, rawMessages, redact, sandboxDenFixture, type ModelKey } from "./packaged-sandbox-fixtures.ts";

const exec = promisify(execFile);
type Options = { binary: string; model: ModelKey; realKey: string; evidenceDir: string; keepRoot?: boolean; expectedGitSha?: string; expectedBundleSha256?: string };
type Assertion = { name: string; ok: boolean; detail: unknown };

export async function packagedSandboxWorld(options: Options) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This packaged microVM journey requires macOS arm64");
  const artifact = await packagedBundle(options.binary);
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
  const den = await sandboxDenFixture();
  const inference = await inferenceFixture(options.model, options.realKey, state);
  const provider = { provider: { [profile.provider]: { npm: profile.npm, name: profile.name,
    options: { baseURL: inference.url, apiKey: inference.token },
    models: { [profile.model]: { name: profile.name, tool_call: true, limit: { context: 200_000, output: 16_000 } } },
  } } };
  await writeFile(join(work, "opencode.json"), JSON.stringify(provider));
  const assertions: Assertion[] = [];
  const transcripts: unknown[] = [];
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
  function check(name: string, ok: boolean, detail: unknown = null) {
    assertions.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} ${options.model}: ${name}`);
    if (!ok) throw new Error(`${name}: ${redact(JSON.stringify(detail), [options.realKey, inference.token])}`);
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
  async function screenshot(name: string) {
    const jumpVisible = await evaluateOnSurface(surface(), () => Array.from(document.querySelectorAll("button"))
      .some(button => button.textContent?.trim() === "Jump to latest" && button.getClientRects().length > 0));
    if (jumpVisible) {
      await clickTarget(surface(), { role: "button", label: "Jump to latest" });
      await waitFor(surface(), () => !Array.from(document.querySelectorAll("button"))
        .some(button => button.textContent?.trim() === "Jump to latest" && button.getClientRects().length > 0),
      { timeoutMs: 10_000, label: "the latest packaged reply is visible before its screenshot" });
    }
    await evaluateOnSurface(surface(), async () => {
      const control = document.querySelector('[data-testid="host-execution-switch"]');
      if (control) await Promise.race([
        Promise.allSettled(control.getAnimations({ subtree: true }).map(animation => animation.finished)),
        new Promise(resolve => setTimeout(resolve, 500)),
      ]);
    }, { awaitPromise: true, timeoutMs: 2000 });
    const result: unknown = await surface().client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    if (!isRecord(result) || typeof result.data !== "string") throw new Error("Screenshot returned no PNG");
    await writeFile(join(evidenceDir, `${options.model}-${name}.png`), Buffer.from(result.data, "base64"));
  }
  const settingsPath = () => `/workspace/${encodeURIComponent(workspaceId)}/sandbox-settings`;
  const native = () => engineSessionProbe({ engine: "v2", surface: surface(), workspaceId });
  async function settings() { return api(settingsPath()); }
  async function settingsRoute() {
    await control(surface(), "route.settings.authorized_folders");
    await waitForLocated(surface(), { testId: "host-execution-switch" }, { timeoutMs: 60_000 });
  }
  async function clickSwitch() { await clickTarget(surface(), { testId: "host-execution-switch" }); }
  async function returnToChat() {
    await clickTarget(surface(), { role: "button", label: "Back to app" });
    await waitForLocated(surface(), "composer", { timeoutMs: 90_000 });
    if (sessionId) await control(surface(), "session.open", { sessionId });
    await waitForLocated(surface(), "composer", { timeoutMs: 90_000 });
  }
  async function send(text: string) {
    // This is the normal composer input + Run task button, not prompt_async or an engine API.
    if (sessionId) {
      const before = await native().snapshot(sessionId);
      if (!before.ok) throw new Error(`Cannot establish the current turn's transcript boundary: HTTP ${before.status}`);
      previousMessageIds = new Set(rawMessages(before.body).flatMap(message => typeof message.id === "string" ? [message.id] : []));
    } else previousMessageIds = new Set();
    await clickTarget(surface(), "composer", { timeoutMs: 90_000 });
    await typeText(surface(), text);
    await clickTarget(surface(), { role: "button", label: "Run task" });
    if (!sessionId) {
      const opened = await waitFor(surface(), () => window.location.hash.match(/\/session\/(ses_[^/?#]+)/)?.[1] ?? null,
        { timeoutMs: 90_000, label: "the normal composer opens its persisted chat" });
      if (typeof opened !== "string") throw new Error("The composer did not open a persisted chat");
      sessionId = opened;
    }
  }
  async function finished(timeoutMs = 600_000) {
    const deadline = Date.now() + timeoutMs;
    let idle = 0;
    while (Date.now() < deadline) {
      const active = await api(`/workspace/${workspaceId}/opencode2/api/session/active`);
      // Applying the queued setting replaces the engine after idle; its proxy can
      // briefly be unavailable. No request is replayed, and the deadline still fails.
      if ([503, 504].includes(active.status)) { idle = 0; await delay(500); continue; }
      if (active.status !== 200) throw new Error(`Active session read failed: ${active.status}`);
      const running = JSON.stringify(active.body).includes(sessionId);
      idle = running ? 0 : idle + 1;
      const snapshot = await native().snapshot(sessionId);
      const phaseRequests = inference.records.filter(entry => entry.phase === state.phase);
      const rejected = phaseRequests.find(entry => entry.status >= 400);
      if (rejected) throw new Error(`Real inference rejected ${rejected.requestedModel}: HTTP ${rejected.status} at ${rejected.path}: ${rejected.responseError ?? "no response detail"}`);
      const currentMessages = turnMessages(snapshot);
      const hasAnswer = phaseRequests.length > 0 && phaseRequests.every(entry => entry.completed)
        && hasStoppedAssistantAnswer(snapshot.body, previousMessageIds);
      if (idle >= 4 && hasAnswer) {
        transcripts.push({ phase: state.phase, ...snapshot });
        check(`${state.phase}: run finishes with no tool still running`, snapshot.ok && currentMessages.flatMap(message => message.parts).every(part => part.type !== "tool" || !["pending", "running"].includes(part.status)), currentMessages);
        return currentMessages.flatMap(message => message.parts);
      }
      await delay(1000);
    }
    throw new Error(`The ${state.phase} turn did not finish in ${timeoutMs}ms`);
  }
  async function waitSettings(predicate: (body: Record<string, unknown>) => boolean) {
    const deadline = Date.now() + 120_000;
    let last: unknown;
    while (Date.now() < deadline) {
      const result = await settings();
      last = result;
      if (result.status === 200 && isRecord(result.body) && predicate(result.body)) return result.body;
      await delay(500);
    }
    throw new Error(`Sandbox settings did not settle: ${JSON.stringify(last)}`);
  }
  async function activeToggle(desiredAllowHostExecution: boolean, phase: string, expectedOs: "Darwin" | "Linux") {
    state.phase = phase;
    const count = inference.records.length;
    const command = "sleep 40; uname -s";
    await send(`Use shell to run exactly: ${command}. Wait for it to finish, then use read to read ${files.notes}. Quote the operating system and the note content. This is a deliberately long-running task; do not stop it. Do not use execute or a different tool.`);
    // Both witnesses are mandatory: session activity is authoritative, and the
    // current turn's actual shell must already be running when Settings changes.
    const deadline = Date.now() + 120_000;
    let active = false;
    while (Date.now() < deadline) {
      const result = await api(`/workspace/${workspaceId}/opencode2/api/session/active`);
      const snapshot = await native().snapshot(sessionId);
      const runningShell = turnMessages(snapshot).flatMap(message => message.parts)
        .some(part => part.tool === "shell" && part.status === "running" && JSON.stringify(part.input).includes(command));
      if (result.status === 200 && JSON.stringify(result.body).includes(sessionId) && inference.records.length > count && runningShell) { active = true; break; }
      await delay(100);
    }
    check(`${phase}: chat is active and the long shell has started before Settings changes`, active);
    await screenshot(`${phase}-running-before-toggle`);
    await settingsRoute();
    const stillActive = await api(`/workspace/${workspaceId}/opencode2/api/session/active`);
    check(`${phase}: chat remains active immediately before clicking the switch`, stillActive.status === 200 && JSON.stringify(stillActive.body).includes(sessionId));
    await clickSwitch();
    const pending = await waitSettings(body => body.pending === true && body.allowHostExecution === desiredAllowHostExecution && body.effectiveAllowHostExecution === !desiredAllowHostExecution);
    check(`${phase}: desired setting is saved while the current run keeps its effective execution mode`, pending.pending === true, pending);
    await waitFor(surface(), browserScript((checked) => document.querySelector('[data-testid="host-execution-switch"]')?.getAttribute("aria-checked") === String(checked), [desiredAllowHostExecution]),
      { timeoutMs: 15_000, label: "the switch displays the saved choice while application is pending" });
    await waitForText(surface(), "finish", { timeoutMs: 15_000 });
    await screenshot(`${phase}-pending`);
    await returnToChat();
    const final = await finished();
    check(`${phase}: the ongoing shell finishes in ${expectedOs} after the switch changes`, final.some(part => part.tool === "shell" && part.status === "completed" && part.output.includes(expectedOs)), final.filter(part => part.tool === "shell"));
    check(`${phase}: a later read in the same ongoing turn is not revoked`, final.some(part => part.tool === "read" && part.status === "completed" && JSON.stringify(part.input).includes(files.notes) && part.output.includes("status:")), final.filter(part => part.tool === "read"));
    const phaseRequests = inference.records.filter(entry => entry.phase === phase);
    if (desiredAllowHostExecution) check(`${phase}: pending host enable does not offer host tools to the guest turn`, hasOnlyDirectGuestTools(phaseRequests), phaseRequests);
    else {
      const executableRequests = phaseRequests.filter(entry => entry.offeredTools.length > 0);
      check(`${phase}: every executable request retains the ongoing host turn's host execution rail`, executableRequests.length > 0 && executableRequests.every(entry =>
        entry.offeredTools.includes("shell") && entry.offeredTools.includes("read")
        || entry.offeredTools.includes("execute") && entry.codeModeTools.includes("shell") && entry.codeModeTools.includes("read")), phaseRequests);
    }
    const applied = await waitSettings(body => body.pending === false && body.allowHostExecution === desiredAllowHostExecution && body.effectiveAllowHostExecution === desiredAllowHostExecution);
    check(`${phase}: pending setting applies only after the run finishes`, applied.pending === false, applied);
    await settingsRoute();
    await screenshot(`${phase}-applied`);
    await returnToChat();
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
    if (error && app) await screenshot("failure").catch(() => undefined);
    const processes = await ownedProcesses().catch(() => []);
    const plugins = await auditConfigs(root).catch(() => []);
    let evidenceFailure: unknown;
    try {
      await writeFile(join(evidenceDir, `${options.model}-report.json`), redact(JSON.stringify({
        scope: "Branch-built packaged macOS arm64 Electron, its embedded app.asar server and staged runtime; real provider inference and microVM. Signed-out Den rollout is a loopback contract fixture, not a production organization.",
        artifact, sourceContext, bakedBuildInfo, expectedGitSha: options.expectedGitSha ?? null, model: profile.model, provider: profile.provider, upstream: profile.upstream, root, workspaceId, sessionId,
        assertions, inference: inference.records, denReads: den.reads, processes, pluginConfigs: plugins,
        fatal: error instanceof Error ? error.stack : error ? String(error) : null,
      }, null, 2), [options.realKey, inference.token]), { mode: 0o600 });
      await writeFile(join(evidenceDir, `${options.model}-transcript.json`), redact(JSON.stringify(transcripts, null, 2), [options.realKey, inference.token]), { mode: 0o600 });
    } catch (error) { evidenceFailure = error; }
    // Stop only this surface/process group. Never search/kill a person's existing app or VM.
    try {
      await app?.stop();
      if (handle) await host.disposeSurface(handle);
      const ownedVms = processes.filter(row => /(?:^|\/)msb machine\b/.test(row.command));
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      for (const row of ownedVms) if (alive(row.pid)) { try { process.kill(row.pid, "SIGTERM"); } catch { /* Exited during cleanup. */ } }
      if (ownedVms.some(row => alive(row.pid))) await delay(2000);
      const leftovers = ownedVms.filter(row => alive(row.pid));
      await writeFile(join(evidenceDir, `${options.model}-cleanup.json`), JSON.stringify({ ownedVmPids: ownedVms.map(row => row.pid), leftovers }, null, 2));
      if (leftovers.length) throw new Error(`Owned VM processes did not stop; keeping ${root} intact`);
      if (!options.keepRoot && !evidenceFailure) await rm(root, { recursive: true, force: true });
    } finally { await Promise.all([den.close(), inference.close()]); }
    if (evidenceFailure) throw evidenceFailure;
  }

  async function launch() {
    await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", artifact.bundle], { timeout: 60_000 });
    check("branch-built app passes deep strict code-signature verification", true);
    const originalEnv = process.env;
    // spawnElectron's normal harness adds owned HOME, state, config, history and OPENCODE_TEST_HOME.
    // Strip ALL inherited OpenCode/OpenWork and Infisical credentials before it sees its parent env.
    process.env = { ...isolatedParentEnvironment(originalEnv), OPENWORK_EVAL_ELECTRON_BINARY: artifact.binary, OPENWORK_EVAL_ENGINE: "v2", OPENWORK_EVAL_ELECTRON_RESOURCES_PREPARED: "1" };
    try {
      handle = await host.spawnElectron(`packaged-sandbox-${options.model}`, {
        profile: "fresh", profileDir: join(root, "profile"), prepareSharedResources: false,
        bootstrap: { baseUrl: den.url, apiBaseUrl: den.url, requireSignin: false },
        env: { MSB_HOME: join(root, "msb"), OPENWORK_DEV_MODE: "0", OPENWORK_ELECTRON_START_URL: "", ELECTRON_START_URL: "", NODE_PATH: "", NODE_OPTIONS: "", ELECTRON_RUN_AS_NODE: "" },
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
    const ordinary = await waitSettings(body => body.featureEnabled === true && body.allowHostExecution === true && body.effectiveAllowHostExecution === true);
    check("reported flow starts with ordinary host execution allowed", ordinary.pending === false, ordinary);
    await settingsRoute();
    await screenshot("before-host-tools-on");
    const granted = await api(`/workspace/${workspaceId}/authorized-folders`, "PUT", { folders: [shared] });
    check("packaged server authorizes only the disposable shared folder", granted.status === 200, granted.body);
    await returnToChat();
    check("fresh packaged workspace is ready for its first normal message", sessionId === "");
  }

  async function exercise() {
    // Reproduce the reported direction first, not just the inverse transition.
    await activeToggle(false, "active-host-to-sandbox", "Darwin");
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
    const offered = inference.records.filter(entry => entry.phase === state.phase);
    check("actual inference API catalog contains exactly six direct guest tools and no host/code-mode tools", hasOnlyDirectGuestTools(offered), offered);
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

    state.phase = "live-host-edit";
    await writeFile(files.reference, updated);
    await send(`Use read to read ${files.reference} at that exact absolute path again. Then use edit to replace ${updated} with ${guest} in the same file. Quote what read returned. Do not use shell or write instead.`);
    const live = await finished();
    check("running guest observes later host edit at unchanged absolute path", live.some(part => part.tool === "read" && part.output.includes(updated)));
    check("guest edit writes back into same host file", (await readFile(files.reference, "utf8")) === guest);
    check("live followup still offers only six direct tools", hasOnlyDirectGuestTools(inference.records.filter(entry => entry.phase === state.phase)));
    await screenshot("live-edits-both-directions");

    await activeToggle(true, "active-sandbox-to-host", "Linux");
    check("every phase used the selected real model", inference.records.length > 0 && inference.records.every(entry => entry.status === 200 && entry.completed && entry.requestedModel === profile.model && entry.responseModel?.startsWith(profile.model)), inference.records);
    check("Den fixture rollout was actually read", den.reads.includes("/v1/features"), den.reads);
    const pluginConfigs = await auditConfigs(root);
    check("owned packaged engine config loads the shipped sandbox plugin", pluginConfigs.length > 0, pluginConfigs);
    const processes = await ownedProcesses();
    const rendererUrl = await evaluateOnSurface(surface(), () => location.href);
    const expectedRendererRoot = `${pathToFileURL(join(artifact.resources, "app-dist")).href}/`;
    check("owned launch PID is alive and its renderer comes from the supplied bundle, with no source server process", processes.some(row => row.pid === handle?.pid)
      && rendererUrl.startsWith(expectedRendererRoot)
      && processes.every(row => !/apps\/server\/src|--import tsx|bun.*src\//.test(row.command)), { launchPid: handle?.pid, rendererUrl, expectedRendererRoot, processes });
  }

  return { launch, exercise, dispose, root, assertions, artifact, inference: inference.records };
}
