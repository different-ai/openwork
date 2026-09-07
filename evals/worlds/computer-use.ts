import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { needs, SkipError } from "@openwork/env";
import type { Place, Seed } from "@openwork/env";
import { desktop } from "@openwork/hosts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pipeClient(executable: string, args: string[]) {
  const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  let nextId = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message: unknown = JSON.parse(line);
    if (!record(message) || typeof message.id !== "number") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const fail = () => {
    for (const value of pending.values()) { clearTimeout(value.timer); value.reject(new Error(`Fixture process exited: ${stderr}`)); }
    pending.clear();
  };
  child.on("error", fail); child.on("exit", fail);
  return {
    pid: child.pid,
    request(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000) {
      const id = ++nextId;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    async close() {
      child.stdin.end(); lines.close();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) { resolve(); return; }
        const timeout = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000);
        child.once("exit", () => { clearTimeout(timeout); resolve(); });
      });
      fail();
    },
  };
}

export function toolState(value: unknown): Record<string, unknown> {
  if (!record(value) || !Array.isArray(value.content)) throw new Error("No tool content");
  const text = value.content.find((item: unknown) => record(item) && item.type === "text");
  if (!record(text) || typeof text.text !== "string") throw new Error("No tool state");
  const result: unknown = JSON.parse(text.text);
  if (!record(result)) throw new Error("Invalid tool state");
  return result;
}

export async function computerUseWorld(_seed: Seed, { place }: { place: Place }, externalHelper?: {
  executable: string;
  /** Locate only the caller-owned app's helper; never launch a replacement. */
  pid(): Promise<number | undefined>;
}) {
  // Do not silently run local Mac resources after the CLI selected Daytona.
  if (place.kind !== "local" || process.platform !== "darwin") throw new SkipError("macOS native desktop placement; the selected host cannot run AppKit");
  needs({ commands: externalHelper ? ["swiftc"] : ["swift", "swiftc"] });
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const native = join(root, "packages/computer-use/native");
  if (!externalHelper) {
    const build = spawnSync("swift", ["build", "--package-path", native, "--product", "ComputerUse"], { encoding: "utf8", timeout: 120_000 });
    if (build.status !== 0) throw new Error(`Computer Use build failed: ${build.stderr.slice(-4000)}`);
  }
  const executable = externalHelper ? externalHelper.executable : join(native, ".build/debug/ComputerUse");
  const checked = spawnSync(executable, ["--check"], { encoding: "utf8", timeout: 5000 });
  if (checked.error || checked.status !== 0) throw new Error("The native Computer Use permission check failed.");
  const permissions: unknown = JSON.parse(checked.stdout);
  if (!record(permissions) || permissions.protocolVersion !== "openwork.computer-use/1"
    || ![permissions.ok, permissions.supported, permissions.accessibility, permissions.screenRecording].every((value) => typeof value === "boolean")) {
    throw new Error("The native Computer Use helper returned an invalid or incompatible permission status.");
  }
  if (!permissions.supported) throw new SkipError("a supported macOS Computer Use helper");
  if (!permissions.accessibility || !permissions.screenRecording) throw new SkipError("macOS Accessibility and Screen Recording granted to the native helper by a person");
  if (!permissions.ok) throw new Error("The native Computer Use helper is not ready despite reporting both permissions.");
  const directory = await mkdtemp(join(tmpdir(), "openwork-computer-use-"));
  const contents = join(directory, "Computer Use Fixture.app/Contents");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await writeFile(join(contents, "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.example.openwork.computer-use-fixture</string><key>CFBundleName</key><string>Computer Use Fixture</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>1.0</string><key>LSMinimumSystemVersion</key><string>14.0</string></dict></plist>`);
  const fixtureExecutable = join(contents, "MacOS/Fixture");
  const compiled = spawnSync("swiftc", ["-parse-as-library", join(root, "evals/packages/labs/fixtures/computer-use-app.swift"), "-o", fixtureExecutable], { encoding: "utf8", timeout: 90_000 });
  if (compiled.status !== 0) { await rm(directory, { recursive: true }); throw new Error(compiled.stderr); }
  const fixture = pipeClient(fixtureExecutable, []);
  const helper = externalHelper ? null : pipeClient(executable, ["mcp"]);
  const peer = externalHelper ? null : pipeClient(executable, ["mcp"]);
  const target = async () => ({ pid: externalHelper ? await externalHelper.pid() : helper?.pid, executable });
  const close = async () => { await Promise.all([helper?.close(), peer?.close(), fixture.close()]); await rm(directory, { recursive: true, force: true }); };
  try {
    await fixture.request("state");
    const fixturePermissions = await fixture.request("permissions");
    if (!record(fixturePermissions) || typeof fixturePermissions.accessibility !== "boolean") throw new Error("The disposable person-input fixture returned an invalid permission status.");
    if (!fixturePermissions.accessibility) throw new SkipError("Accessibility permission for the disposable native person-input fixture");
    await helper?.request("initialize", { protocolVersion: "2025-11-25", clientInfo: { name: "native-journey", version: "1" }, capabilities: {} });
    await peer?.request("initialize", { protocolVersion: "2025-11-25", clientInfo: { name: "peer-journey", version: "1" }, capabilities: {} });
    const owned = (client: typeof helper) => {
      if (!client) throw new Error("The caller owns the native helper; use its product tool boundary.");
      return client;
    };
    return {
      async electronFixture() {
        const main = join(directory, "electron-fixture.cjs");
        await writeFile(main, `
          const { app, BrowserWindow } = require('electron');
          const readline = require('node:readline');
          let window;
          const ready = app.whenReady().then(async () => {
            window = new BrowserWindow({ width: 600, height: 420, title: 'Electron Fixture' });
            await window.loadURL('data:text/html,' + encodeURIComponent('<title>Electron Fixture</title><main><h1>Fixture workspace</h1><button>Fixture action</button><input aria-label="Fixture draft" value="Fixture draft value"></main>'));
          });
          readline.createInterface({ input: process.stdin }).on('line', async (line) => {
            const request = JSON.parse(line); await ready;
            process.stdout.write(JSON.stringify({ id: request.id, result: { accessibility: app.isAccessibilitySupportEnabled() } }) + '\\n');
          }).on('close', () => app.quit());
        `);
        const require = createRequire(join(root, "apps/desktop/package.json"));
        const electron: unknown = require("electron");
        if (typeof electron !== "string") throw new Error("Electron executable unavailable");
        const client = pipeClient(electron, [main]);
        try {
          await client.request("state");
          const discovered = toolState(await owned(helper).request("tools/call", { name: "computer_discover", arguments: {} }));
          const identity = Array.isArray(discovered.apps) ? discovered.apps.find((entry: unknown) => record(entry) && entry.pid === client.pid) : undefined;
          if (!record(identity) || typeof identity.app_id !== "string") throw new Error("Electron fixture was not discoverable");
          return { appId: identity.app_id, pid: client.pid, state: () => client.request("state"), [Symbol.asyncDispose]: () => client.close() };
        } catch (error) { await client.close(); throw error; }
      },
      desktop: () => desktop({ name: "computer-use-setup", host: place.host(), env: { OPENWORK_COMPUTER_USE_BINARY: executable } }),
      workspacePath: join(directory, "workspace"),
      appId: "org.example.openwork.computer-use-fixture",
      appPid: fixture.pid,
      call: (name: string, args: Record<string, unknown> = {}) => owned(helper).request("tools/call", { name, arguments: args }),
      peerCall: (name: string, args: Record<string, unknown> = {}) => owned(peer).request("tools/call", { name, arguments: args }),
      list: () => owned(helper).request("tools/list"),
      state: () => fixture.request("state"),
      refreshChanges: (continuous: boolean) => fixture.request("refresh_changes", { continuous }),
      refreshStable: () => fixture.request("refresh_stable"),
      refreshState: () => fixture.request("refresh_state"),
      resize: () => fixture.request("resize"),
      async setupPanel() {
        const setup = spawn(executable, ["setup"], { stdio: "ignore" });
        try {
          await new Promise<void>((resolve, reject) => { setup.once("spawn", resolve); setup.once("error", reject); });
          const deadline = Date.now() + 5_000;
          let lastPanel: unknown;
          while (Date.now() < deadline) {
            const result = await fixture.request("helper_panel", { name: "", pid: setup.pid, executable });
            lastPanel = result;
            if (record(result) && typeof result.text === "string" && result.text.includes("Accessibility")) return result;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          throw new Error(`The setup window did not show permission status: ${JSON.stringify(lastPanel)}`);
        } finally {
          setup.kill("SIGTERM");
          await new Promise<void>((resolve) => {
            if (setup.exitCode !== null || setup.signalCode !== null || !setup.pid) { resolve(); return; }
            const timeout = setTimeout(() => { setup.kill("SIGKILL"); resolve(); }, 2_000);
            setup.once("exit", () => { clearTimeout(timeout); resolve(); });
          });
        }
      },
      panel: async () => fixture.request("helper_panel", { name: "", ...await target() }),
      foregroundWindow: () => fixture.request("foreground_window"),
      minimized: () => fixture.request("minimized"),
      minimize: () => fixture.request("minimize"),
      restore: () => fixture.request("restore"),
      humanEdit: async () => {
        if (externalHelper) {
          // Self-activation needs no System Events/Apple Events authorization.
          // The fixture checks ownership and focus before posting any input.
          await fixture.request("front");
        } else {
          const activated = spawnSync("/usr/bin/osascript", ["-e", `tell application "System Events" to set frontmost of (first application process whose unix id is ${fixture.pid}) to true`], { encoding: "utf8", timeout: 5000 });
          if (activated.status !== 0) throw new Error(activated.stderr);
        }
        return fixture.request("human_edit");
      },
      prepareDrag: () => fixture.request("prepare_drag"),
      dragState: () => fixture.request("drag_state"),
      front: () => fixture.request("front"),
      async selectWindow() {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const result = await fixture.request("select_helper_window", { name: "Workspace window", ...await target() });
          if (record(result) && result.ok === true) return result;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("The native window picker did not become available.");
      },
      async pressControl(name: "Allow this session" | "Cancel" | "Take over" | "Continue" | "Stop" | "Hide panel" | "Show Computer Use task") {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const result = await fixture.request("press_helper_button", { name, ...await target() });
          if (record(result) && result.ok === true) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`The native ${name} control did not become available; the person-input fixture may need Accessibility permission.`);
      },
      [Symbol.asyncDispose]: close,
    };
  } catch (error) { await close(); throw error; }
}
