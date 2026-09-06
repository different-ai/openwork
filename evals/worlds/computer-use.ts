import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
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

export async function computerUseWorld(_seed: Seed, { place }: { place: Place }) {
  // Do not silently run local Mac resources after the CLI selected Daytona.
  if (place.kind !== "local" || process.platform !== "darwin") throw new SkipError("macOS native desktop placement; the selected host cannot run AppKit");
  needs({ commands: ["swift", "swiftc"] });
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const native = join(root, "packages/computer-use/native");
  const build = spawnSync("swift", ["build", "--package-path", native, "--product", "ComputerUse"], { encoding: "utf8", timeout: 120_000 });
  if (build.status !== 0) throw new Error(`Computer Use build failed: ${build.stderr.slice(-4000)}`);
  const executable = join(native, ".build/debug/ComputerUse");
  const checked = spawnSync(executable, ["--check"], { encoding: "utf8", timeout: 5000 });
  const permissions: unknown = JSON.parse(checked.stdout);
  if (!record(permissions) || permissions.ok !== true) throw new SkipError("macOS Accessibility and Screen Recording granted to the native helper by a person");
  const directory = await mkdtemp(join(tmpdir(), "openwork-computer-use-"));
  const contents = join(directory, "Computer Use Fixture.app/Contents");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await writeFile(join(contents, "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.example.openwork.computer-use-fixture</string><key>CFBundleName</key><string>Computer Use Fixture</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>1.0</string><key>LSMinimumSystemVersion</key><string>14.0</string></dict></plist>`);
  const fixtureExecutable = join(contents, "MacOS/Fixture");
  const compiled = spawnSync("swiftc", ["-parse-as-library", join(root, "evals/packages/labs/fixtures/computer-use-app.swift"), "-o", fixtureExecutable], { encoding: "utf8", timeout: 90_000 });
  if (compiled.status !== 0) { await rm(directory, { recursive: true }); throw new Error(compiled.stderr); }
  const fixture = pipeClient(fixtureExecutable, []);
  const helper = pipeClient(executable, ["mcp"]);
  const peer = pipeClient(executable, ["mcp"]);
  const close = async () => { await Promise.all([helper.close(), peer.close(), fixture.close()]); await rm(directory, { recursive: true, force: true }); };
  try {
    await fixture.request("state");
    const fixturePermissions = await fixture.request("permissions");
    if (!record(fixturePermissions) || fixturePermissions.accessibility !== true) throw new SkipError("Accessibility permission for the disposable native person-input fixture");
    await helper.request("initialize", { protocolVersion: "2025-11-25", clientInfo: { name: "native-journey", version: "1" }, capabilities: {} });
    await peer.request("initialize", { protocolVersion: "2025-11-25", clientInfo: { name: "peer-journey", version: "1" }, capabilities: {} });
    return {
      desktop: () => desktop({ name: "computer-use-setup", host: place.host(), env: { OPENWORK_COMPUTER_USE_BINARY: executable } }),
      workspacePath: join(directory, "workspace"),
      appId: "org.example.openwork.computer-use-fixture",
      appPid: fixture.pid,
      call: (name: string, args: Record<string, unknown> = {}) => helper.request("tools/call", { name, arguments: args }),
      peerCall: (name: string, args: Record<string, unknown> = {}) => peer.request("tools/call", { name, arguments: args }),
      list: () => helper.request("tools/list"),
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
      panel: () => fixture.request("helper_panel", { name: "", pid: helper.pid, executable }),
      foregroundWindow: () => fixture.request("foreground_window"),
      minimized: () => fixture.request("minimized"),
      minimize: () => fixture.request("minimize"),
      restore: () => fixture.request("restore"),
      humanEdit: async () => {
        const activated = spawnSync("/usr/bin/osascript", ["-e", `tell application "System Events" to set frontmost of (first application process whose unix id is ${fixture.pid}) to true`], { encoding: "utf8", timeout: 5000 });
        if (activated.status !== 0) throw new Error(activated.stderr);
        return fixture.request("human_edit");
      },
      prepareDrag: () => fixture.request("prepare_drag"),
      dragState: () => fixture.request("drag_state"),
      front: () => fixture.request("front"),
      async selectWindow() {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const result = await fixture.request("select_helper_window", { name: "Workspace window", pid: helper.pid, executable });
          if (record(result) && result.ok === true) return result;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("The native window picker did not become available.");
      },
      async pressControl(name: "Allow this session" | "Cancel" | "Take over" | "Continue" | "Stop" | "Hide panel" | "Show Computer Use task") {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const result = await fixture.request("press_helper_button", { name, pid: helper.pid, executable });
          if (record(result) && result.ok === true) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`The native ${name} control did not become available; the person-input fixture may need Accessibility permission.`);
      },
      [Symbol.asyncDispose]: close,
    };
  } catch (error) { await close(); throw error; }
}
