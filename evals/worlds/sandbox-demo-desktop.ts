import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { attachSurface, browserScript, evaluateOnSurface, pressKey, reload, type Surface } from "@openwork/cdp";
import { control, createAndSelectWorkspace, engineSessionProbe, signInDesktopAs, waitForText, type DenSession } from "@openwork/behaviors";
import { localHost } from "@openwork/hosts";
import { hasStoppedAssistantAnswer, inferenceFixture, isRecord, isolatedParentEnvironment, profiles, sandboxDenFixture } from "./packaged-sandbox-fixtures.ts";
import { button, exec, film, motion, poll, requireDemo, testId } from "./sandbox-demo-film.ts";

export type Ui = ReturnType<typeof motion>;
export async function packagedDemoDesktop(cleanup: AsyncDisposableStack, input: { root: string; signal: AbortSignal; buildSha: string; key?: string; den?: { webUrl: string; apiUrl: string; member: DenSession } }) {
  const bundle = "/tmp/owafter/OpenWork.app";
  const execDir = join(bundle, "Contents/MacOS");
  const [binary, ...other] = await readdir(execDir);
  requireDemo(binary && !other.length, "Expected one packaged executable");
  const work = join(input.root, "Sandbox Demo");
  await mkdir(work);
  const fixture = input.den ? null : await sandboxDenFixture(true);
  if (fixture) cleanup.defer(fixture.close);
  const state = { phase: "boot", hostSecret: randomUUID() };
  const profile = profiles.fable;
  const inference = input.key ? await inferenceFixture("fable", input.key, state) : null;
  if (inference) cleanup.defer(inference.close);
  const provider = inference ? { provider: { [profile.provider]: { npm: profile.npm, name: profile.name, options: { baseURL: inference.url, apiKey: inference.token }, models: { [profile.model]: { name: profile.name, tool_call: true, limit: { context: 200_000, output: 16_000 } } } } } } : null;
  if (provider) await writeFile(join(work, "opencode.json"), JSON.stringify(provider), { mode: 0o600 });
  const host = localHost();
  const originalEnv = process.env;
  const baseUrl = input.den?.webUrl ?? fixture?.url;
  const apiBaseUrl = input.den?.apiUrl ?? fixture?.url;
  requireDemo(baseUrl && apiBaseUrl, "No loopback Den URL");
  const handle = await (async () => {
    process.env = { ...isolatedParentEnvironment(originalEnv), OPENWORK_EVAL_ELECTRON_BINARY: join(execDir, binary), OPENWORK_EVAL_ENGINE: "v2", OPENWORK_EVAL_ELECTRON_RESOURCES_PREPARED: "1" };
    try {
      return await host.spawnElectron("sandbox-demo", { profile: "fresh", profileDir: join(input.root, "profile"), prepareSharedResources: false,
        bootstrap: { baseUrl, apiBaseUrl, requireSignin: Boolean(input.den) }, env: { MSB_HOME: join(input.root, "msb"), OPENWORK_DEV_MODE: "0", OPENWORK_ELECTRON_START_URL: "", ELECTRON_START_URL: "", NODE_PATH: "", NODE_OPTIONS: "", ELECTRON_RUN_AS_NODE: "" } });
    } finally { process.env = originalEnv; }
  })();
  cleanup.defer(async () => {
    const [{ stdout }] = await Promise.all([exec("ps", ["-axo", "pid=,ppid=,command="]).catch(() => ({ stdout: "" }))]);
    const rows = stdout.split("\n").flatMap(line => { const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line); return m ? [{ pid: Number(m[1]), parent: Number(m[2]), cmd: m[3] ?? "" }] : []; });
    const parents = new Map(rows.map(row => [row.pid, row.parent]));
    const owned = rows.filter(row => {
      if (!handle.pid || !/(?:^|\/)msb machine\b/.test(row.cmd)) return false;
      for (let hop = 0, pid: number | undefined = row.pid; hop < 64 && pid; hop++, pid = parents.get(pid)) if (pid === handle.pid) return true;
      return false;
    });
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try { await host.disposeSurface(handle); }
    finally {
      for (const row of owned) if (alive(row.pid)) { try { process.kill(row.pid, "SIGTERM"); } catch {} }
      if (owned.some(row => alive(row.pid))) await delay(1800);
      for (const row of owned) if (alive(row.pid)) { try { process.kill(row.pid, "SIGKILL"); } catch {} }
      if (owned.some(row => alive(row.pid))) await delay(500);
      requireDemo(owned.every(row => !alive(row.pid)), "An owned VM did not terminate");
    }
  });
  const app = cleanup.use(await attachSurface(handle, { timeoutMs: 40_000 }));
  await app.client.send("Page.bringToFront");
  requireDemo(await evaluateOnSurface(app, () => {
    const meta: unknown = Reflect.get(window.__OPENWORK_ELECTRON__, "meta");
    return typeof meta === "object" && meta !== null && Reflect.get(meta, "isPackaged") === true && location.href.startsWith("file:") && location.href.includes("/Contents/Resources/app-dist/");
  }), "Renderer is not bundled Electron");
  const info: unknown = await evaluateOnSurface(app, () => window.__OPENWORK_ELECTRON__.invokeDesktop("appBuildInfo"), { awaitPromise: true });
  requireDemo(isRecord(info), "Missing packaged build info");
  if (typeof info.gitSha === "string" && info.gitSha) requireDemo(info.gitSha.startsWith(input.buildSha), "Packaged renderer build SHA mismatch");
  if (input.den) await signInDesktopAs(app, input.den, input.den.member);
  const { workspaceId } = await createAndSelectWorkspace(app, { path: work });
  const api = (suffix: string, method = "GET", body?: unknown) => evaluateOnSurface(app, browserScript(async (path, method, encoded) => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!info.running || !info.baseUrl) throw new Error("Embedded server not running");
    const response = await fetch(String(info.baseUrl).replace(/\/+$/, "") + path, { method, headers: { authorization: `Bearer ${info.ownerToken ?? info.clientToken ?? ""}`, "content-type": "application/json" }, ...(encoded === null ? {} : { body: encoded }), signal: AbortSignal.timeout(5000) });
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body };
  }, [`/workspace/${encodeURIComponent(workspaceId)}${suffix}`, method, body === undefined ? null : JSON.stringify(body)]), { awaitPromise: true, timeoutMs: 8000 });
  if (provider) {
    requireDemo((await api("/config", "PATCH", { opencode: provider })).status === 200, "Could not configure isolated Fable provider");
    await evaluateOnSurface(app, browserScript((providerID, modelID) => {
      let previous: unknown = {};
      try { previous = JSON.parse(localStorage.getItem("openwork.preferences") ?? "{}"); } catch {}
      if (typeof previous !== "object" || previous === null) previous = {};
      localStorage.setItem("openwork.preferences", JSON.stringify({ ...Object(previous), defaultModel: { providerID, modelID }, modelVariant: null, providerStepCompleted: true }));
      localStorage.setItem("openwork.defaultModel", `${providerID}/${modelID}`);
    }, [profile.provider, profile.model]));
    await reload(app);
    await waitForText(app, profile.name, { timeoutMs: 45_000 });
  }
  await pressKey(app, "Escape");
  await delay(500);
  const settings = (predicate: (body: Record<string, unknown>) => boolean) => poll("embedded sandbox settings", () => api("/sandbox-settings"), row => row.status === 200 && isRecord(row.body) && predicate(row.body));
  const native = engineSessionProbe({ engine: "v2", surface: app, workspaceId });
  const sessionNow = () => evaluateOnSurface(app, () => location.hash.match(/\/session\/(ses_[^/?#]+)/)?.[1] ?? "");
  async function send(ui: Ui, prompt: string, phase: string, alreadyTyped = false) {
    state.phase = phase;
    if (!alreadyTyped) await ui.type(prompt);
    await ui.click(button("Run task"), 0);
    return poll("new task opens a persisted session", sessionNow, Boolean, 6500);
  }
  async function result(id: string, phase: string, timeout = 43_000) {
    const snapshot = await poll("Fable finishes a new assistant answer", async () => {
      input.signal.throwIfAborted();
      const rejected = inference?.records.find(row => row.phase === phase && row.completed && row.status >= 400);
      if (rejected) throw new Error(`Fable inference returned HTTP ${rejected.status}`);
      return native.snapshot(id).catch(() => null);
    }, row => Boolean(row?.ok && hasStoppedAssistantAnswer(row.body, new Set())), timeout, 350);
    requireDemo(snapshot?.ok && inference?.records.some(row => row.phase === phase && row.status === 200 && row.responseModel?.startsWith(profile.model)), "No confirmed Fable 5.2 response");
    return snapshot.data.messages.flatMap(message => message.parts);
  }
  return { app, api, work, settings, native, send, result, sessionNow };
}

export async function openPermissions(ui: Ui) {
  await ui.click(testId("account-status-menu"));
  await ui.click({ role: "menuitem", text: "Settings" });
  await ui.click("Permissions", 0);
  await ui.see("authorized-folders-panel", 3500);
}
export async function ready(ui: Ui, app: Surface, api: ReturnType<typeof packagedDemoDesktop> extends Promise<infer T> ? T extends {api: infer A} ? A : never : never, folder?: string) {
  await ui.see("sandbox-ready", 40_000);
  await poll("Ready folder row Can edit", () => evaluateOnSurface(app, browserScript(folder => [...document.querySelectorAll('[data-testid="sandbox-folder"]')].some(row => row.textContent?.includes("Can edit") && (!folder || row.textContent.includes(folder))), [folder ?? null])), Boolean, 10_000);
  await poll("embedded sandbox status ready", () => api("/sandbox-status"), row => row.status === 200 && isRecord(row.body) && row.body.state === "ready", 10_000);
}
const back = (ui: Ui) => ui.click(button("Back to app"));
const worked = (ui: Ui) => ui.click(button(/^Worked for/));
type Desktop = Awaited<ReturnType<typeof packagedDemoDesktop>>;
type Part = Awaited<ReturnType<Desktop["result"]>>[number];
function hostTool(part: Part) { return part.tool === "shell" || (part.tool === "execute" && JSON.stringify(part.input).includes("tools.shell")); }
function os(parts: Part[], filter: (part: Part) => boolean, expected: string) {
  requireDemo(parts.some(part => filter(part) && part.status === "completed" && new RegExp(`\\b${expected}\\b`).test(part.output)), `Transcript did not prove ${expected}`);
}
export async function runDesktopClip(n: string, desktop: Desktop, root: string, signal: AbortSignal) {
  const { app, api, send, result, settings, native } = desktop;
  const ui = motion(app, signal);
  const shots: string[] = [];
  const save = async (name: string) => { const path = join(root, `${name}.png`); await ui.still(path); shots.push(path); };
  const directory = join(root, "film");
  let progress = 0;
  const normal = "Run uname -s and tell me the result.";
  const room = await settings(body => body.featureEnabled === true && body.verification === "verified" && body.useSandbox === false && body.forceSandbox === false);
  requireDemo(room.status === 200, "Sandbox fixture did not enable the controls");
  let folder = "";
  if (n === "04") {
    folder = join(root, "Shared Notes");
    await mkdir(folder);
    await writeFile(join(folder, "notes.txt"), "draft from the Mac\n");
    requireDemo((await api("/authorized-folders", "PUT", { folders: [folder] })).status === 200, "Could not authorize the notes folder");
  }
  if (n === "02" || n === "04") {
    await control(app, "route.settings.authorized_folders");
    await ui.click(testId("sandbox-use-switch"), 0);
    await ready(ui, app, api, folder ? "Shared Notes" : undefined);
    await back(ui);
  }
  const outcome = await film(app, directory, signal, async ui => {
    if (n === "01") {
      await openPermissions(ui);
      await delay(750);
      await ui.click(testId("sandbox-use-switch"), 0);
      const end = Date.now() + 4500;
      while (Date.now() < end && !progress) {
        const frame = await evaluateOnSurface(app, () => ({ active: !!document.querySelector('[data-testid^="sandbox-step-"][data-state="active"]'), ready: !!document.querySelector('[data-testid="sandbox-ready"]'), now: Date.now() }));
        if (frame.active) progress = frame.now;
        if (frame.ready) break;
        await delay(25);
      }
      await ready(ui, app, api);
      await save("01-first-enable-ready");
      return `Embedded sandbox-status: ready; folder row: Can edit. ${progress ? "Active setup step sampled." : "Setup completed before an active step could be sampled."}`;
    }
    if (n === "02") {
      requireDemo((await ui.see("sandbox-mode-pill")).text.trim() === "Sandbox", "Expected Sandbox composer pill");
      const id = await send(ui, "Run uname -s in the sandbox, then run uname -s with the normal shell tool, and tell me both results.", "dual");
      const parts = await result(id, "dual");
      os(parts, part => part.tool === "sandbox_shell", "Linux");
      os(parts, hostTool, "Darwin");
      await ui.maybeClick(button("Jump to latest"));
      await worked(ui);
      await ui.maybeClick(button(/^Ran .*commands/));
      await ui.see("sandbox-tag", 5000);
      await save("02-use-mode-chat");
      return "Fable transcript: sandbox_shell → Linux; normal shell → Darwin. Expanded work showed a Sandbox tag.";
    }
    if (n === "03") {
      await openPermissions(ui);
      await ui.click(testId("sandbox-force-switch"), 0);
      await waitForText(app, "Included in Force OpenWork Sandbox", { timeoutMs: 6500 });
      requireDemo(await evaluateOnSurface(app, () => !!document.querySelector('[data-testid="sandbox-use-switch"][aria-checked="true"]:is(:disabled,[aria-disabled="true"])')), "Use was not checked and locked by Force");
      await settings(body => body.effectiveForceSandbox === true && body.pending === false);
      await ready(ui, app, api);
      await delay(1600);
      await back(ui);
      requireDemo((await ui.see("sandbox-mode-pill")).text.trim() === "Sandbox only", "Expected Sandbox only composer pill");
      const id = await send(ui, "Run uname -s and tell me the result. Then try to read /etc/hosts-openwork-demo-does-not-exist and tell me what happened.", "force");
      const parts = await result(id, "force");
      os(parts, part => part.tool === "shell", "Linux");
      requireDemo(parts.some(part => part.tool && JSON.stringify(part.input).includes("hosts-openwork-demo-does-not-exist") && (part.status === "error" || /not found|not mounted|outside|denied|no such file|does not exist/i.test(part.output + part.error))), "Transcript did not prove the harmless path was rejected");
      await ui.maybeClick(button("Jump to latest"));
      await save("03-force-mode-chat");
      return "Effective Force true; Fable transcript: shell → Linux, and the nonexistent path was attempted and rejected.";
    }
    if (n === "04") {
      await openPermissions(ui);
      await ready(ui, app, api, "Shared Notes");
      await waitForText(app, "Shared Notes", { timeoutMs: 5000 });
      await delay(2000);
      await back(ui);
      const id = await send(ui, `In the sandbox, read ${folder}/notes.txt and append the line 'edited in the sandbox'. Then use the normal shell tool to show the file from the Mac.`, "folders");
      const parts = await result(id, "folders");
      const text = await readFile(join(folder, "notes.txt"), "utf8");
      requireDemo(text.trim() === "draft from the Mac\nedited in the sandbox" && parts.some(part => part.tool.startsWith("sandbox_") && /draft from the Mac/.test(part.output)) && parts.some(part => hostTool(part) && part.output.includes("draft from the Mac") && part.output.includes("edited in the sandbox")), "Host file and both tool sides were not confirmed");
      await ui.maybeClick(button("Jump to latest"));
      await save("04-folders-both-sides");
      return "Ready folder: Can edit. Sandbox read the draft. Host tool output and the Mac file both contained ‘draft from the Mac’ and ‘edited in the sandbox’.";
    }
    if (n === "05") {
      const first = await send(ui, "Use the shell tool to run: sleep 25; uname -s. Wait for it to finish and tell me the result.", "long");
      await poll("host sleep command is running", () => native.snapshot(first), row => row.ok && row.data.messages.flatMap(m => m.parts).some(part => hostTool(part) && part.status === "running" && JSON.stringify(part.input).includes("sleep 25")), 22_000);
      await openPermissions(ui);
      await ui.click(testId("sandbox-force-switch"), 0);
      await ui.see("sandbox-pending", 4000);
      await settings(body => body.pending === true && body.effectiveForceSandbox === false);
      await save("05-mid-chat-toggle-pending");
      await delay(1200);
      await back(ui);
      await ui.click(button("New session"), 100);
      await ui.type(normal);
      await ui.click(button("Run task"), 0);
      await ui.see("sandbox-send-note", 4000);
      requireDemo(await draftPresent(app, normal), "Pending send lost the draft or displayed a destructive error");
      await save("05-mid-chat-toggle-note");
      await delay(1800);
      try {
        const title = await poll("first task has a title", () => native.get(first).catch(() => null), row => Boolean(row?.ok && row.data?.title), 5000);
        requireDemo(title?.data?.title, "Missing title for first task");
        const firstTitle = title.data.title;
        const sidebar = await ui.maybeClick(button(firstTitle));
        if (!sidebar) {
          await ui.click(button("Search sessions"));
          const resultTarget = { role: "option", text: new RegExp(firstTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) } satisfies import("@openwork/cdp").Target;
          await ui.click(resultTarget);
        }
        await poll("back to first task", desktop.sessionNow, id => id === first, 5000);
      } catch {
        await pressKey(app, "Escape");
        os(await result(first, "long"), hostTool, "Darwin");
        return "Draft: The pending setting and neutral draft-retention notice were captured. The first task returned Darwin through the transcript, but reopening it through the session picker failed. The Linux retry is not shown.";
      }
      os(await result(first, "long"), hostTool, "Darwin");
      await delay(2000);
      await settings(body => body.pending === false && body.effectiveForceSandbox === true);
      await openPermissions(ui);
      await ready(ui, app, api);
      await delay(2000);
      await back(ui);
      await ui.click({ role: "button", text: /^Run uname -s/ });
      requireDemo(await draftPresent(app, normal), "Saved draft was not present after Force applied");
      const second = await send(ui, normal, "applied", true);
      requireDemo(second !== first, "Retry opened the wrong session");
      os(await result(second, "applied"), part => part.tool === "shell", "Linux");
      return "Force queued with both neutral notices and the draft intact. The pre-change call returned Darwin; after Force took effect, resending the retained prompt returned Linux.";
    }
    throw new Error("Unknown desktop clip");
  });
  return { outcome, directory, progress, shots };
}

function draftPresent(app: Surface, prompt: string) {
  return evaluateOnSurface(app, browserScript(prompt => [...document.querySelectorAll('[contenteditable="true"],textarea')].some(node => node.getClientRects().length && (node instanceof HTMLTextAreaElement ? node.value : node.textContent)?.includes(prompt)) && !/sandbox_engine_busy|Couldn.t send your message|Not sent/.test(document.body.innerText), [prompt]));
}
