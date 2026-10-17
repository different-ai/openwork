/** Run as root inside a dedicated desktop-image test guest with its X server running. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createDesktopApplications } from "/usr/local/share/openwork-desktop/apps.mjs";

if (process.argv[2] !== "--dedicated-guest") throw new Error("This check operates the desktop. Pass --dedicated-guest only inside a disposable test computer.");
const execute = promisify(execFile);
const display = process.env.DISPLAY ?? ":99";
process.env.DISPLAY = display;
const directory = `/workspace/out/desktop-apps-proof-${randomUUID()}`;
await execute("/usr/sbin/runuser", ["-u", "ubuntu", "--", "sh", "-c", 'umask 077; mkdir "$1"', "_", directory]);
const applications = createDesktopApplications({ directory: `${directory}/logs`, display });
const catalog = await applications.list();
assert.equal(catalog.apps.filter(app => !app.available).length, 0, JSON.stringify(catalog));
await writeFile(`${directory}/catalog.json`, JSON.stringify(catalog, null, 2));
const deadline = AbortSignal.timeout(180_000);
await assert.rejects(applications.launch({ app: "not-an-app" }, deadline), { code: "invalid_app" });
await assert.rejects(applications.launch({ app: "blender", path: "--python-expr=bad" }, deadline), { code: "invalid_path" });

async function window(pattern) {
  for (let n = 0; n < 120; n++) {
    deadline.throwIfAborted();
    const found = await execute("xdotool", ["search", "--onlyvisible", "--class", pattern], { timeout: 3000 }).then(result => result.stdout.trim().split("\n").at(-1), () => undefined);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`No visible window for ${pattern}`);
}
const windows = {};
for (const [app, pattern] of [["writer", "libreoffice-writer"], ["gimp", "gimp"], ["inkscape", "inkscape"], ["blender", "blender"]]) {
  await applications.launch({ app }, deadline);
  windows[app] = await window(pattern);
}

// A real GUI save verifies the two users can exchange files, not just list apps.
const note = `${directory}/note.txt`;
await execute("/usr/sbin/runuser", ["-u", "ubuntu", "--", "sh", "-c", 'umask 077; printf "Before editing\\n" > "$1"', "_", note]);
await applications.launch({ app: "editor", path: note }, deadline);
const editor = await window("mousepad");
// A mapped window can precede document loading and other apps' startup focus.
await new Promise(resolve => setTimeout(resolve, 1500));
await execute("xdotool", ["windowactivate", "--sync", editor], { timeout: 3000 });
await new Promise(resolve => setTimeout(resolve, 250));
await execute("xdotool", ["key", "--clearmodifiers", "ctrl+a"], { timeout: 3000 });
await new Promise(resolve => setTimeout(resolve, 100));
await execute("xdotool", ["type", "--clearmodifiers", "--delay", "40", "--", "Saved from the shared desktop"], { timeout: 5000 });
await execute("xdotool", ["key", "--clearmodifiers", "ctrl+s"], { timeout: 3000 });
for (let n = 0; n < 30 && !(await readFile(note, "utf8")).includes("Saved from the shared desktop"); n++) await new Promise(resolve => setTimeout(resolve, 100));
assert.ok((await readFile(note, "utf8")).includes("Saved from the shared desktop"));
await execute("/usr/sbin/runuser", ["-u", "ubuntu", "--", "test", "-r", note]);

// The GUI works without a GPU, and CPU rendering produces an inspectable artifact.
const render = `${directory}/cube.png`;
await execute("/usr/sbin/runuser", ["-u", "openwork-browser", "--", "blender", "--background", "--factory-startup", "--threads", "2", "--python-expr", `import bpy; s=bpy.context.scene; s.render.engine='CYCLES'; s.cycles.device='CPU'; s.cycles.use_denoising=False; s.cycles.samples=4; s.render.resolution_x=96; s.render.resolution_y=96; s.render.resolution_percentage=100; s.render.filepath=${JSON.stringify(render)}; bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(`${directory}/cube.blend`)}); bpy.ops.render.render(write_still=True)`], { timeout: 120_000, maxBuffer: 1024 * 1024, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/openwork-browser", LIBGL_ALWAYS_SOFTWARE: "1", GALLIUM_DRIVER: "llvmpipe" } });
assert.ok((await stat(render)).size > 100);
await execute("xdotool", ["windowactivate", "--sync", windows.blender]);
await execute("import", ["-window", "root", `${directory}/desktop.png`], { timeout: 5000 });
console.log(JSON.stringify({ directory, installedApps: catalog.apps.length, visibleApps: Object.keys(windows), sharedGuiSave: true, blenderCpuRender: true }));
