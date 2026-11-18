// Run only as root in a disposable desktop-image guest with its X server running.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createDesktopApplications } from "/usr/local/share/openwork-desktop/apps.mjs";

assert.ok(process.argv.includes("--dedicated-guest") && process.platform === "linux" && process.getuid() === 0,
  "Run only inside a disposable desktop guest with --dedicated-guest.");
const exec = promisify(execFile);
const directory = `/workspace/out/scripting-safety-${randomUUID()}`;
await exec("runuser", ["-u", "ubuntu", "--", "mkdir", directory]);
const display = process.env.DISPLAY ?? ":99";
const applications = createDesktopApplications({ display, authority: process.env.XAUTHORITY, directory: `${directory}/logs` });
const signal = AbortSignal.timeout(180_000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
assert.equal(await exec("pgrep", ["-u", "openwork-app", "-x", "blender"]).then(() => true, () => false), false,
  "The fixture must start without existing Blender sessions.");
async function script(code, extra = {}, taskSignal = signal) {
  return applications.script({ app: "blender", code, ...extra }, taskSignal);
}
async function ready() {
  for (let n = 0; n < 120; n++) {
    signal.throwIfAborted();
    try { const result = await script("import os\nresult = os.getpid()"); if (result.mode === "open session") return result.result; }
    catch (error) { if (!["script_not_ready", "script_target_ambiguous"].includes(error.code)) throw error; }
    await pause(250);
  }
  throw new Error("Blender did not open its bridge.");
}
async function focus(pid) {
  const windows = (await exec("xdotool", ["search", "--onlyvisible", "--class", "blender"])).stdout.trim().split("\n");
  for (const window of windows) {
    const owner = await exec("xdotool", ["getwindowpid", window]).then(result => Number(result.stdout), () => null);
    if (owner === pid) { await exec("xdotool", ["windowactivate", "--sync", window]); return; }
  }
  throw new Error("No window for the intended Blender instance.");
}

await applications.launch({ app: "blender" }, signal);
const first = await ready();
await script('bpy.context.scene.name = "First scene"');
// Exercise arbitrary Python in the real app, including subprocesses. Neither
// browser-private files nor TCP/DNS are available to this account.
const canary = "/home/openwork-browser/scripting-security-canary";
await writeFile(canary, "private browser state", { mode: 0o600 });
await exec("chown", ["openwork-browser:openwork-browser", canary]);
const security = await script(`
import os, socket, subprocess
try:
    open(${JSON.stringify(canary)}).read()
    readable = True
except PermissionError:
    readable = False
def connects(family, host, port):
    connection = socket.socket(family, socket.SOCK_STREAM)
    connection.settimeout(1)
    try:
        return connection.connect_ex((host, port)) == 0
    finally:
        connection.close()
result = {
    "uid": os.getuid(), "browserReadable": readable,
    "workerReachable": connects(socket.AF_INET, "127.0.0.1", 9222),
    "publicReachable": connects(socket.AF_INET, "1.1.1.1", 443),
    "ipv6Reachable": connects(socket.AF_INET6, "::1", 9222),
    "subprocessEgress": subprocess.run(["curl", "--noproxy", "*", "--connect-timeout", "1", "https://1.1.1.1"], capture_output=True).returncode == 0
}
`);
assert.equal(security.ok, true, JSON.stringify(security));
assert.deepEqual(security.result, { uid: Number((await exec("id", ["-u", "openwork-app"])).stdout),
  browserReadable: false, workerReachable: false, publicReachable: false, ipv6Reachable: false, subprocessEgress: false });
await applications.launch({ app: "blender" }, signal);
let second;
for (let n = 0; n < 120 && !second; n++) {
  const pids = (await exec("pgrep", ["-u", "openwork-app", "-x", "blender"])).stdout.trim().split("\n").map(Number);
  const candidate = pids.find(pid => pid !== first);
  if (candidate) {
    try { await focus(candidate); second = await ready(); }
    catch (error) { if (signal.aborted) throw error; }
  }
  if (!second) await pause(250);
}
assert.ok(second && second !== first);
await script('bpy.context.scene.name = "Second scene"');
await focus(first);
assert.equal((await script("result = bpy.context.scene.name")).result, "First scene");
await focus(second);
assert.equal((await script("result = bpy.context.scene.name")).result, "Second scene");

const blend = `${directory}/scene.blend`;
await script(`bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blend)})`);
const before = createHash("sha256").update(await readFile(blend)).digest("hex");
const marker = `${directory}/render-started`;
const stop = new AbortController();
const rendering = script(`
from pathlib import Path
def rendering_started(scene):
    Path(${JSON.stringify(marker)}).write_text("started")
bpy.app.handlers.render_pre.append(rendering_started)
bpy.context.scene.render.engine = "CYCLES"
bpy.context.scene.cycles.device = "CPU"
bpy.context.scene.cycles.samples = 32
bpy.context.scene.cycles.use_denoising = False
bpy.context.scene.render.resolution_x = 512
bpy.context.scene.render.resolution_y = 512
bpy.context.scene.render.resolution_percentage = 100
bpy.context.scene.name = "Unsaved edit"
`, { render: "final", output: `${directory}/render.png`, save: true }, stop.signal);
const rejected = assert.rejects(rendering, { code: "script_stopped" });
for (let n = 0; !await stat(marker).then(() => true, () => false); n++) {
  signal.throwIfAborted(); assert.ok(n < 600, "The render must actually begin before Stop"); await pause(100);
}
stop.abort();
await rejected;
assert.equal(createHash("sha256").update(await readFile(blend)).digest("hex"), before, "Stop during rendering must prevent the following save");
assert.equal((await script("result = bpy.context.scene.name")).result, "Unsaved edit");

// An unrelated open Writer must not turn a direct-file Calc edit into an unsaved window edit.
await applications.launch({ app: "writer" }, signal);
await exec("runuser", ["-u", "openwork-app", "--", "sh", "-c",
  'cd "$1"; printf "Before\\n" > budget.csv; soffice -env:UserInstallation=file:///tmp/scripting-safety-office --headless --convert-to ods budget.csv >/dev/null', "_", directory], { timeout: 60_000 });
const path = `${directory}/budget.ods`;
const written = await applications.script({ app: "calc", path, operation: "write_range", range: "A1", values: [["Persisted edit"]] }, signal);
assert.equal(written.ok, true, JSON.stringify(written));
assert.equal(written.saved, true);
assert.equal(written.target, "file");
const reopened = await applications.script({ app: "calc", path, operation: "read_range", range: "A1" }, signal);
assert.deepEqual(reopened.values, [["Persisted edit"]]);
const writer = await applications.script({ app: "writer", operation: "insert_text", text: "Still open" }, signal);
assert.equal(writer.ok, true, JSON.stringify(writer));
assert.equal(writer.target, "open window");
assert.equal(writer.unsaved, true);
console.log(JSON.stringify({ correctBlenderInstance: true, stopDuringNativeRenderAcknowledged: true,
  noSaveAfterStop: true, directFileSavedWithWriterOpen: true, unrelatedWriterPreserved: true,
  browserProfileIsolated: true, appNetworkBlocked: true }));
