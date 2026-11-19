import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

// Installed by the desktop image next to apps.mjs. Older snapshots report scripting unavailable.
export const SCRIPTING_DIR = "/usr/local/share/openwork-desktop/scripting";
const home = "/home/openwork-app";
// Unix sockets, not loopback ports: the desktop egress guard refuses loopback for the desktop user.
export const BLENDER_DIRECTORY = `${home}/.local/state/openwork-scripting`;
export const OFFICE_ACCEPT = "--accept=pipe,name=openwork-office;urp;StarOffice.ComponentContext";
export const SCRIPT_LANES = { blender: "blender", writer: "office", calc: "office", impress: "office", draw: "office", gimp: "gimp", inkscape: "inkscape" };
export const blenderBridgeArgs = () => ["--python", `${SCRIPTING_DIR}/openwork_blender.py`, "--", "serve", BLENDER_DIRECTORY];

const failure = (code, message) => Object.assign(new Error(message), { code });
const path = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const LANE_KEYS = {
  blender: ["code", "path", "render", "output", "save", "timeoutMs"],
  office: ["operation", "path", "range", "sheet", "values", "text", "at", "output", "save", "timeoutMs"],
  gimp: ["path", "output", "width", "height", "rotate", "timeoutMs"],
  inkscape: ["path", "output", "width", "height", "area", "transform", "timeoutMs"],
};
const filePath = value => typeof value === "string" && value.length <= 4096 && !value.includes("\0") && !value.includes("\n") && isAbsolute(value);
const size = value => value === undefined || Number.isInteger(value) && value > 0 && value <= 8192;
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");

/**
 * Drives desktop apps through their own scripting interfaces. Every script runs as the desktop
 * app account, without browser-profile or network access. Stop or takeover cancels it.
 */
export function createAppScripting({ display, available }) {
  const env = { PATH: path, HOME: home, USER: "openwork-app", LOGNAME: "openwork-app", LANG: "C.UTF-8", DISPLAY: display, XAUTHORITY: `${home}/.Xauthority`, LIBGL_ALWAYS_SOFTWARE: "1", GALLIUM_DRIVER: "llvmpipe" };
  const installed = () => access(`${SCRIPTING_DIR}/openwork_blender.py`, constants.R_OK).then(() => true, () => false);

  /** Runs a command as the desktop user; stdin is JSON. Abort kills its whole process group. */
  function runAs(command, argv, { input, timeoutMs, signal }) {
    signal?.throwIfAborted();
    const root = process.getuid?.() === 0;
    const child = spawn(root ? "/usr/sbin/runuser" : command, root ? ["-u", "openwork-app", "--", command, ...argv] : argv, { env, cwd: "/workspace", detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-400_000); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-20_000); });
    child.stdin.on("error", () => {});
    child.stdin.end(input === undefined ? "" : JSON.stringify(input));
    return new Promise((resolve, reject) => {
      let stopped = null;
      const kill = reason => { stopped ??= reason; try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } };
      const timer = setTimeout(() => kill("timeout"), timeoutMs);
      const abort = () => kill("stopped");
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", error => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(error); });
      child.once("close", code => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        if (stopped === "stopped") return reject(failure("script_stopped", "Stopped before the script finished; the app may have applied part of it. Observe the app before changing anything, and never rerun the script without checking."));
        if (stopped) return reject(failure("script_timeout", "The script ran out of time and was ended; the app may have applied part of it. Check the result before rerunning anything."));
        resolve({ code, stdout, stderr });
      });
    });
  }

  async function blender(args, timeoutMs, signal) {
    if (typeof args.code !== "string" || !args.code.trim() || args.code.length > 32_000) throw failure("invalid_arguments", "Provide bpy Python code of at most 32000 characters.");
    if (args.render !== undefined && !["viewport", "final"].includes(args.render)) throw failure("invalid_arguments", "render is viewport or final.");
    if (args.output !== undefined && !(filePath(args.output) && args.output.endsWith(".png"))) throw failure("invalid_path", "Use an absolute .png output path.");
    if (args.path !== undefined && !(filePath(args.path) && args.path.endsWith(".blend"))) throw failure("invalid_path", "Use an absolute .blend path.");
    const job = { id: randomUUID(), code: args.code, timeout: timeoutMs / 1000, save: args.save === true,
      ...(args.render ? { render: args.render, output: args.output ?? `/workspace/out/blender-${stamp()}.png` } : {}) };
    // A file path is edited in a background Blender so the open session is untouched.
    let socketPath = null;
    if (args.path === undefined) {
      const processes = await runAs("/usr/bin/pgrep", ["-u", "openwork-app", "-x", "blender"], { timeoutMs: 3000, signal });
      const pids = processes.stdout.trim().split(/\s+/).filter(value => /^[1-9]\d*$/.test(value));
      let pid = pids[0];
      if (pids.length > 1) {
        const focused = await runAs("/usr/bin/xdotool", ["getactivewindow", "getwindowpid"], { timeoutMs: 3000, signal });
        pid = focused.stdout.trim();
        if (!pids.includes(pid)) throw failure("script_target_ambiguous", "Several Blender instances are open. Focus the intended Blender window, or pass a file path for a background edit.");
      }
      if (pid) {
        socketPath = `${BLENDER_DIRECTORY}/blender-${pid}.sock`;
        if (!await stat(socketPath).then(file => file.isSocket(), () => false)) throw failure("script_not_ready", "The selected Blender is not serving scripts yet. Wait for it to finish opening; older sessions need to be relaunched.");
      }
    }
    const session = socketPath ? await blenderSession(socketPath, job, timeoutMs, signal) : null;
    if (session) return { mode: "open session", ...session };
    const result = await runAs("/usr/bin/blender", ["--background", ...(args.path ? [args.path] : []), "--python", `${SCRIPTING_DIR}/openwork_blender.py`, "--", "run"], { input: job, timeoutMs, signal });
    const line = result.stdout.split("\n").reverse().find(line => line.startsWith("OPENWORK_RESULT "));
    if (!line) throw failure("script_failed", `Blender exited before reporting (exit ${result.code}). ${result.stderr.slice(-1500)}`);
    return { mode: "background", ...JSON.parse(line.slice("OPENWORK_RESULT ".length)),
      ...(args.path === undefined && args.save !== true ? { note: "No Blender window was open, so this ran on a fresh scene that is discarded unless the script saves it." } : {}) };
  }

  /** Stop requests cancellation, then waits for Blender to acknowledge it. */
  function blenderSession(socketPath, job, timeoutMs, signal) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const socket = connect({ path: socketPath });
      let connected = false, data = "", settled = false, stopped = null;
      const finish = (error, value) => {
        if (settled) return; settled = true;
        clearTimeout(timer); signal?.removeEventListener("abort", abort); socket.destroy();
        error ? reject(error) : resolve(value);
      };
      const cancel = reason => {
        stopped ??= reason;
        if (connected && !socket.destroyed) socket.write(`${JSON.stringify({ cancel: job.id })}\n`);
      };
      const abort = () => cancel("script_stopped");
      const timer = setTimeout(() => cancel("script_timeout"), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      socket.once("connect", () => {
        if (stopped) return finish(failure(stopped, "Stopped before sending the script to Blender. Nothing was dispatched."));
        connected = true; socket.write(`${JSON.stringify(job)}\n`);
      });
      socket.on("data", chunk => {
        data += chunk;
        if (data.length > 2_000_000) return finish(failure("script_failed", "Blender's reply was too large."));
        const end = data.indexOf("\n");
        if (end >= 0) {
          try {
            const receipt = JSON.parse(data.slice(0, end));
            if (stopped) finish(failure(stopped, "Blender has finished the interrupted operation. Part of it may have run; inspect the scene before making further changes."));
            else finish(null, receipt);
          } catch { finish(failure("script_uncertain", "Blender sent an unreadable reply. Inspect the scene before continuing.")); }
        }
      });
      socket.once("error", error => connected
        ? finish(failure("script_uncertain", "The connection to Blender broke while the script ran; part of it may have run. Inspect the scene before rerunning anything."))
        : finish(failure("script_not_ready", "The selected Blender bridge is unavailable. Reopen that instance before scripting it.")));
      socket.once("close", () => { if (connected) finish(failure("script_uncertain", "Blender closed the connection before reporting; inspect the scene before rerunning anything.")); });
    });
  }

  async function office(app, args, timeoutMs, signal) {
    if (!["read_range", "write_range", "insert_text", "export_pdf"].includes(args.operation)) throw failure("invalid_arguments", "Use operation read_range, write_range, insert_text or export_pdf.");
    if (["read_range", "write_range"].includes(args.operation) && app !== "calc") throw failure("invalid_arguments", "Cell ranges need app calc.");
    if (args.operation === "insert_text" && app !== "writer") throw failure("invalid_arguments", "insert_text needs app writer.");
    if (args.path !== undefined && !filePath(args.path)) throw failure("invalid_path", "Use an absolute file path.");
    const input = { ...args, ...(args.operation === "export_pdf" && args.output === undefined ? { output: `/workspace/out/${app}-${stamp()}.pdf` } : {}) };
    const result = await runAs("/usr/bin/python3", ["-I", `${SCRIPTING_DIR}/openwork_office.py`], { input, timeoutMs, signal });
    const line = result.stdout.trim().split("\n").at(-1) ?? "";
    try { return JSON.parse(line); }
    catch { throw failure("script_failed", `LibreOffice exited before reporting (exit ${result.code}). ${result.stderr.slice(-1500)}`); }
  }

  async function converted(command, argv, args, timeoutMs, signal) {
    const started = Date.now() - 1000;
    const result = await runAs(command, argv, { timeoutMs, signal });
    const written = await stat(args.output).then(file => file.size > 0 && file.mtimeMs >= started, () => false);
    if (result.code !== 0 || !written) return { ok: false, error: `No output was written (exit ${result.code}). ${result.stderr.slice(-1500)}`.trim() };
    if (!/\.(png|jpe?g|webp|tiff?|gif)$/i.test(args.output)) return { ok: true, path: args.path, output: args.output };
    const shape = await runAs("/usr/bin/identify", ["-format", "%w %h", `${args.output}[0]`], { timeoutMs: 10_000, signal }).catch(() => null);
    const [width, height] = shape?.code === 0 ? shape.stdout.split(" ").map(Number) : [];
    return { ok: true, path: args.path, output: args.output, ...(width ? { width, height } : {}) };
  }

  function gimp(args, timeoutMs, signal) {
    if (!filePath(args.path) || !filePath(args.output)) throw failure("invalid_path", "Use absolute path and output files; the output extension picks the format.");
    if (!size(args.width) || !size(args.height) || args.rotate !== undefined && ![90, 180, 270].includes(args.rotate)) throw failure("invalid_arguments", "width and height are 1-8192 pixels; rotate is 90, 180 or 270.");
    const text = value => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    const steps = [
      // Indexed images cannot be exported to JPEG; GIMP would leave an empty file.
      "(if (= (car (gimp-image-base-type image)) INDEXED) (gimp-image-convert-rgb image))",
      args.rotate ? `(gimp-image-rotate image ROTATE-${args.rotate})` : "",
      args.width || args.height ? `(gimp-image-scale image ${args.width ?? `(round (* (car (gimp-image-width image)) (/ ${args.height} (car (gimp-image-height image)))))`} ${args.height ?? `(round (* (car (gimp-image-height image)) (/ ${args.width} (car (gimp-image-width image)))))`})` : "",
    ].join(" ");
    const batch = `(let* ((image (car (gimp-file-load RUN-NONINTERACTIVE ${text(args.path)} ${text(args.path)})))) ${steps} (let ((layer (car (gimp-image-merge-visible-layers image CLIP-TO-IMAGE)))) (gimp-file-save RUN-NONINTERACTIVE image layer ${text(args.output)} ${text(args.output)})) (gimp-image-delete image))`;
    return converted("/usr/bin/gimp", ["-i", "-n", "-d", "-f", "--batch-interpreter", "plug-in-script-fu-eval", "-b", batch, "-b", "(gimp-quit 0)"], args, timeoutMs, signal);
  }

  function inkscape(args, timeoutMs, signal) {
    if (!filePath(args.path) || !filePath(args.output)) throw failure("invalid_path", "Use absolute path and output files; the output extension picks the format.");
    if (!size(args.width) || !size(args.height) || args.area !== undefined && !["page", "drawing"].includes(args.area)) throw failure("invalid_arguments", "width and height are 1-8192 pixels; area is page or drawing.");
    if (args.transform !== undefined && (typeof args.transform !== "string" || args.transform.length > 2000 || !/^[\w:;,.#\- ]+$/.test(args.transform))) throw failure("invalid_arguments", "transform is a semicolon-separated Inkscape action list, such as select-all;object-rotate-90-cw.");
    return converted("/usr/bin/inkscape", [args.path, ...(args.transform ? [`--actions=${args.transform}`] : []), `--export-filename=${args.output}`,
      ...(args.width ? [`--export-width=${args.width}`] : []), ...(args.height ? [`--export-height=${args.height}`] : []), ...(args.area === "drawing" ? ["--export-area-drawing"] : [])], args, timeoutMs, signal);
  }

  return {
    installed,
    async run(args, signal) {
      if (!args || typeof args !== "object") throw failure("invalid_app", "Use an app id from computer_apps.");
      const { app, ...rest } = args;
      const lane = SCRIPT_LANES[app];
      if (!lane) throw failure("invalid_app", `Scripting works for ${Object.keys(SCRIPT_LANES).join(", ")}.`);
      const unknown = Object.keys(rest).filter(key => !LANE_KEYS[lane].includes(key));
      if (unknown.length) throw failure("invalid_arguments", `${app} scripts take ${LANE_KEYS[lane].join(", ")}; remove ${unknown.join(", ")}.`);
      if (rest.timeoutMs !== undefined && (!Number.isInteger(rest.timeoutMs) || rest.timeoutMs < 1000 || rest.timeoutMs > 110_000)) throw failure("invalid_arguments", "timeoutMs is 1000 to 110000.");
      if (!await installed() || !await available(app)) throw failure("app_unavailable", "This computer's snapshot cannot script that app. Rebuild the desktop image to add it.");
      const timeoutMs = rest.timeoutMs ?? 60_000;
      delete rest.timeoutMs;
      const result = lane === "blender" ? await blender(rest, timeoutMs, signal)
        : lane === "office" ? await office(app, rest, timeoutMs, signal)
        : lane === "gimp" ? await gimp(rest, timeoutMs, signal) : await inkscape(rest, timeoutMs, signal);
      return { app, ...result };
    },
  };
}
