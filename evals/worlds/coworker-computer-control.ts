import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { evalIn, waitFor } from "@openwork/behaviors";
import { needs, SkipError, type Place, type Seed } from "@openwork/env";
import { coworker, type CoworkerHandle } from "@openwork/hosts";
import { record, scriptedToolModel, type ScriptedToolStep, type ToolReceipt } from "../packages/labs/src/scripted-tool-model.ts";
import { computerUseWorld, toolState } from "./computer-use.ts";

export const START_PROMPT = "Start a private discussion for the disposable window check.";
export const CONTROL_PROMPT = "In the disposable fixture, increment the workspace counter and edit the draft, then let me take over before continuing. Leave the other window alone.";
export const OFF_PROMPT = "Check whether computer access is available in this new private discussion. Do not request approval or open an app.";
export const COMPUTER_TOOLS = ["coworker_computer_discover", "coworker_computer_open", "coworker_computer_observe", "coworker_computer_act", "coworker_computer_status", "coworker_computer_close"];

const exec = promisify(execFile);

/** Traverse only descendants of our launched surface, never enumerate user apps. */
async function helperPids(root: number, executable: string): Promise<number[]> {
  const signal = AbortSignal.timeout(5_000);
  const found: number[] = [];
  let parents = [root];
  let visited = 0;
  for (let depth = 0; parents.length && depth < 12; depth++) {
    const children: number[] = [];
    for (const parent of parents) {
      if (++visited > 256) throw new Error("Owned Coworker process tree exceeded its bound");
      const pids = await exec("/usr/bin/pgrep", ["-P", String(parent)], { signal, timeout: 2_000 }).catch((error: unknown) => {
        if (record(error) && error.code === 1) return { stdout: "" };
        throw error;
      });
      for (const value of pids.stdout.trim().split(/\s+/).filter(Boolean)) {
        const pid = Number(value);
        if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("Invalid owned child PID");
        children.push(pid);
        const description = await exec("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], { signal, timeout: 2_000 }).catch((error: unknown) => {
          if (record(error) && error.code === 1) return { stdout: "" };
          throw error;
        });
        if (description.stdout.trim() === `${executable} mcp`) found.push(pid);
      }
    }
    parents = children;
  }
  if (parents.length) throw new Error("Owned Coworker process tree exceeded its depth bound");
  return found;
}

function receipt(receipts: ToolReceipt[], id: string) {
  const found = receipts.find((item) => item.id === id);
  if (!found) throw new Error(`No native tool receipt for ${id}`);
  return found;
}

function result(receipts: ToolReceipt[], id: string) {
  return toolState(JSON.parse(receipt(receipts, id).output));
}

function action(receipts: ToolReceipt[], id: string, label: string, type: "press" | "set_value") {
  const observed = result(receipts, id);
  if (observed.ok !== true || typeof observed.observation_id !== "string" || !Array.isArray(observed.elements)) throw new Error(`No successful native observation at ${id}`);
  const element = observed.elements.find((item: unknown) => record(item) && item.label === label);
  if (!record(element) || typeof element.ref !== "string") throw new Error(`No observed ref for ${label}`);
  return { observation_id: observed.observation_id, action: { type, ref: element.ref, ...(type === "set_value" ? { text: "Reviewed in Coworker" } : {}) } };
}

export async function coworkerComputerControlWorld(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local" || process.platform !== "darwin") throw new SkipError("isolated LOCAL macOS desktop with disposable windows; no Daytona substitution");
  needs({ placement: "local", commands: ["opencode", "swiftc"] });
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const binary = process.env.OPENWORK_EVAL_ELECTRON_BINARY?.trim();
  const resources = binary ? resolve(dirname(binary), "../Resources") : join(root, "apps/coworker/resources");
  const executable = join(resources, "helpers/OpenWork Computer Use.app/Contents/MacOS/ComputerUse");
  await access(executable).catch(() => { throw new SkipError("the shared Computer Use app prepared in Coworker's resources/helpers (no helper override)"); });
  const stack = new AsyncDisposableStack();
  let app: CoworkerHandle | undefined;
  const helpers = () => {
    if (!app?.handle.pid) return Promise.resolve([]);
    return helperPids(app.handle.pid, executable);
  };
  try {
    // --check and the disposable fixture's AX trust check run before the model
    // or Coworker starts. Neither opens permission setup or grants permission.
    const fixture = stack.use(await computerUseWorld(seed, { place }, { executable, async pid() {
      const pids = await helpers();
      if (pids.length > 1) throw new Error("More than one runtime helper belongs to this Coworker launch");
      return pids[0];
    } }));
    if (!fixture.appPid) throw new Error("Disposable fixture has no PID");
    const open = (mode: "assist" | "control") => ({ app_id: fixture.appId, pid: fixture.appPid, mode, purpose: "Edit only the disposable workspace window, with a person-controlled handoff." });
    const steps: ScriptedToolStep[] = [
      { id: "discover", name: COMPUTER_TOOLS[0], args: {}, gate: "begin" },
      { id: "assist-open", name: COMPUTER_TOOLS[1], args: open("assist") },
      { id: "assist-observe", name: COMPUTER_TOOLS[2], args: { include_image: false } },
      { id: "assist-increment", name: COMPUTER_TOOLS[3], args: (r) => action(r, "assist-observe", "Increment", "press") },
      { id: "assist-draft", name: COMPUTER_TOOLS[2], args: { include_image: false } },
      { id: "assist-edit", name: COMPUTER_TOOLS[3], args: (r) => action(r, "assist-draft", "Draft text", "set_value") },
      { id: "assist-status", name: COMPUTER_TOOLS[4], args: {} },
      { id: "assist-close", name: COMPUTER_TOOLS[5], args: {} },
      { id: "control-open", name: COMPUTER_TOOLS[1], args: open("control"), gate: "control" },
      { id: "control-before", name: COMPUTER_TOOLS[2], args: { include_image: false } },
      { id: "takeover-status", name: COMPUTER_TOOLS[4], args: {}, gate: "takeover" },
      { id: "stale-action", name: COMPUTER_TOOLS[3], args: (r) => action(r, "control-before", "Increment", "press") },
      { id: "control-fresh", name: COMPUTER_TOOLS[2], args: { include_image: false }, gate: "fresh" },
      { id: "control-increment", name: COMPUTER_TOOLS[3], args: (r) => action(r, "control-fresh", "Increment", "press") },
      { id: "control-after", name: COMPUTER_TOOLS[2], args: { include_image: false } },
      { id: "after-stop", name: COMPUTER_TOOLS[2], args: { include_image: false }, gate: "stop" },
    ];
    const model = stack.use(await scriptedToolModel([
      { prompt: START_PROMPT, reply: "The discussion is ready.", steps: [] },
      { prompt: CONTROL_PROMPT, reply: "The disposable window check is finished.", steps },
      { prompt: OFF_PROMPT, reply: "Computer access is off in this discussion.", steps: [{ id: "new-off", name: COMPUTER_TOOLS[0], args: {} }] },
    ]));
    const profileDir = await mkdtemp(join(tmpdir(), "coworker-computer-control-"));
    stack.defer(() => rm(profileDir, { recursive: true, force: true }));
    const provider = { "eval-computer": { npm: "@ai-sdk/openai-compatible", name: "Local computer witness", options: { baseURL: model.baseUrl, apiKey: "eval-only" }, models: { scripted: { name: "Scripted", tool_call: true, limit: { context: 65536, output: 4096 } } } } };
    const cleared = Object.fromEntries(Object.keys(process.env).filter((key) => /^(OPENCODE_|COWORKER_)/.test(key) || /(_API_KEY|_ACCESS_TOKEN|_AUTH_TOKEN)$/.test(key)).map((key) => [key, ""]));
    app = await coworker({ name: "computer-control", host: place.host(), profileDir, env: {
      ...cleared,
      COWORKER_HOME_DIR: join(profileDir, "coworkers"),
      COWORKER_USER_DATA_DIR: join(profileDir, "electron-userdata"),
      COWORKER_SERVER_CONFIG: join(profileDir, "coworker-server.json"),
      OPENWORK_RUNTIME_DB: join(profileDir, "runtime.sqlite"),
      OPENWORK_SERVER_STATE_PATH: join(profileDir, "server-state.json"),
      OPENWORK_SERVER_TOKEN_STORE_PATH: join(profileDir, "server-tokens.json"),
      OPENCODE_CONFIG_DIR: join(profileDir, "opencode-config"),
      OPENCODE_DB: join(profileDir, "opencode.db"),
      CODEX_HOME: join(profileDir, "codex"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: ["eval-computer"], provider }),
    } });
    const surface = app;
    stack.defer(() => surface.stop());
    const invoke = async (command: string, payload: Record<string, unknown> = {}) => {
      const envelope = await evalIn(surface, `window.__COWORKER__.invoke(${JSON.stringify(command)}, ${JSON.stringify(payload)})`, { awaitPromise: true, timeoutMs: 120_000 });
      // The live preload/main IPC returns {ok, result}, not the UI adapter value.
      if (!record(envelope) || envelope.ok !== true || !record(envelope.result)) throw new Error(`Coworker arrangement failed: ${command}`);
      return envelope.result;
    };
    const created = await invoke("coworkers.create", { name: "Editor", role: "Writing partner", mission: "Review the disposable fixture only.", avatarColor: "blue", avatarGlasses: "round" });
    if (typeof created.workspaceId !== "string" || !created.workspaceId) throw new Error("No native coworker workspace");
    await invoke("coworkers.update", { slug: "editor", patch: { model: "eval-computer/scripted", modelVariant: "" } });
    const runtime = await invoke("runtime.info");
    if (typeof runtime.serverUrl !== "string" || typeof runtime.ownerToken !== "string" || new URL(runtime.serverUrl).hostname !== "127.0.0.1") throw new Error("Coworker did not launch a loopback native server");
    const response = await fetch(`${runtime.serverUrl}/workspace/${encodeURIComponent(created.workspaceId)}/opencode/provider`, { headers: { Authorization: `Bearer ${runtime.ownerToken}` }, signal: AbortSignal.timeout(30_000) });
    const providers: unknown = await response.json();
    if (!response.ok || !record(providers) || JSON.stringify(providers.connected) !== JSON.stringify(["eval-computer"])) throw new Error("The isolated engine must connect only the localhost model witness");
    await evalIn(surface, "location.reload(); true");
    await waitFor(surface, `document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() === "Ready" && Boolean(document.querySelector('textarea[aria-label="Message Editor"]'))`, { timeoutMs: 180_000, label: "isolated native coworker ready" });
    return {
      app: surface, fixture, model, helpers,
      result: (id: string) => result(model.receipts, id),
      receipt: (id: string) => receipt(model.receipts, id),
      async ui() {
        const state = await evalIn(surface, `(() => {
          const get = (key) => document.querySelector('[data-testid="coworker-computer-' + key + '"]');
          const target = get("target");
          return { status: get("status")?.textContent, phase: get("phase")?.textContent,
            placement: get("placement")?.textContent, target: target?.value,
            canAllow: get("allow")?.disabled === false, canStop: get("stop")?.disabled === false,
            setupRequired: get("readiness")?.dataset.state === "setup-required",
            activeDiscussion: document.querySelector('[data-testid="coworker-discussion-menu"] [aria-checked="true"]')?.dataset.threadId,
            targets: target ? [...target.options].map(o => ({ id: o.value, disabled: o.disabled })) : [],
            idle: document.querySelector('[data-testid="coworker-thread-status"]')?.dataset.state === "idle",
            session: get("session")?.textContent ?? "" };
        })()`);
        if (!record(state)) throw new Error("Coworker computer UI state is unavailable");
        return state;
      },
      [Symbol.asyncDispose]: () => stack.disposeAsync(),
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}
