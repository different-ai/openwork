// A computer use driver for a Linux VM with an X11 display. It needs only two
// things from the VM, which every `@openwork/sandbox` provider supplies: run a
// shell command and read a file. Input goes through xdotool and screenshots
// through ImageMagick, batched so one action costs one round trip.
import { randomUUID } from "node:crypto";

const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const TOOLS = ["xdotool", "import", "python3"];

/**
 * @param {{
 *   machine: { run: (command: string, timeoutMs: number) => Promise<{ exitCode: number, stdout: string, stderr: string }>, read: (path: string, timeoutMs: number) => Promise<Uint8Array> },
 *   display?: string,
 *   timeoutMs?: number,
 * }} options
 * @returns {import("./computer-remote.mjs").ComputerDriver}
 */
export function createX11Driver({ machine, display = ":99", timeoutMs = 20_000 }) {
  const validDisplay = /^:\d{1,3}(\.\d)?$/.test(display);
  const directory = `/tmp/openwork-computer-${randomUUID()}`;
  const run = (script, ms = timeoutMs) => {
    if (!validDisplay) throw new Error("Use an X display such as :99.");
    return machine.run(`export DISPLAY=${display}; ${script}`, ms);
  };
  const socketPath = `${directory}/input.sock`;
  let worker = null;
  const bootstrap = async () => {
    if (!worker) worker = (async () => {
      // Server development can load the cloud host while computer use is off,
      // before build artifacts exist. Resolve embedded bytes only on first use.
      const { computerWorkerSource } = await import("./dist/worker.js");
      const workerSource = Buffer.from(computerWorkerSource).toString("base64");
      return run(`python3 -c ${quote(`import base64, os, pathlib, socket, subprocess, time
root = pathlib.Path(${JSON.stringify(directory)})
root.mkdir(mode=0o700, exist_ok=True)
source = root / "worker.py"
source.write_bytes(base64.b64decode(${JSON.stringify(workerSource)}))
os.chmod(source, 0o600)
endpoint = ${JSON.stringify(socketPath)}
def ready():
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(0.2)
    try:
        client.connect(endpoint)
        return True
    except (FileNotFoundError, ConnectionRefusedError): return False
    finally: client.close()
if ready(): raise SystemExit(0)
pathlib.Path(endpoint).unlink(missing_ok=True)
subprocess.Popen(["python3", str(source), ${JSON.stringify(socketPath)}], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
for _ in range(250):
    if ready(): break
    time.sleep(0.02)
else: raise RuntimeError("The VM input worker did not start")`)} `, 10_000);
    })().then((result) => {
      if (result.exitCode !== 0) throw new Error("The VM input worker could not start.");
    }).catch((error) => { worker = null; throw error; });
    await worker;
  };
  const rpc = async (request) => {
    const script = `import json, socket
request = ${JSON.stringify(JSON.stringify(request))}
client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.settimeout(${Math.max(1, timeoutMs / 1000)})
try: client.connect(${JSON.stringify(socketPath)})
except (FileNotFoundError, ConnectionRefusedError):
    print(json.dumps({"code":"worker_unavailable","completed":0,"attempted":False}))
else:
    try:
        client.sendall((request + "\\n").encode())
        with client.makefile("rb") as stream: print(stream.readline(1048576).decode())
    finally: client.close()`;
    const result = await run(`python3 -c ${quote(script)}`, timeoutMs + 1000);
    if (result.exitCode !== 0) throw new Error("The VM operation returned no receipt. Do not repeat input without observing.");
    return JSON.parse(result.stdout);
  };
  const callWorker = async (request) => {
    await bootstrap();
    let result = await rpc(request);
    if (result.code === "worker_unavailable") {
      // A failed connect dispatched nothing; a missing response after send is
      // uncertain and is never retried. Idle workers are restarted on demand.
      worker = null;
      await bootstrap();
      result = await rpc(request);
    }
    return result;
  };
  const integer = (value) => {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number) || Math.abs(number) > 100_000) throw new Error("Coordinates must be finite pixels.");
    return number;
  };
  // X11 window ids are large; they are not pixels.
  const windowId = (value) => {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Unknown window.");
    return id;
  };

  return {
    platform: "linux",
    async describe() {
      try {
        const result = await run(`missing=""; for tool in ${TOOLS.join(" ")}; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done; echo "missing:$missing"; xdotool getdisplaygeometry >/dev/null 2>&1 && echo display:ok`, 10_000);
        const missing = result.stdout.match(/missing:(.*)/)?.[1].trim();
        if (missing) return { readiness: "setup-required", detail: `This VM needs ${missing.split(/\s+/).join(" and ")}. Install them (for example apt-get install -y xdotool imagemagick python3).` };
        if (!result.stdout.includes("display:ok")) return { readiness: "setup-required", detail: `This VM has no desktop on display ${display}. Start one (for example Xvfb ${display}) and try again.` };
        return { readiness: "ready", detail: "Ready" };
      } catch (error) {
        return { readiness: "unavailable", detail: `Could not reach this VM: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
    async screen() {
      const result = await run("xdotool getdisplaygeometry");
      const [width, height] = result.stdout.trim().split(/\s+/).map(Number);
      if (!width || !height) throw new Error("The VM's display size is unavailable.");
      return { x: 0, y: 0, width, height };
    },
    async windows() {
      // Metadata is untrusted. JSON framing prevents titles/classes containing
      // tabs or newlines from creating another approval candidate. Geometry is
      // parsed as numbers, never evaluated as shell code.
      const script = String.raw`
import json, pathlib, subprocess

def command(*args):
    return subprocess.run(["xdotool", *args], check=True, capture_output=True, text=True, timeout=3).stdout.rstrip("\n")

windows = []
try: ids = command("search", "--onlyvisible", "--name", ".").splitlines()
except subprocess.CalledProcessError: ids = []
for value in dict.fromkeys(ids):
    if len(windows) >= 128: break
    try:
        window = int(value)
        if not 0 < window <= 0xffffffff: continue
        raw = dict(line.split("=", 1) for line in command("getwindowgeometry", "--shell", str(window)).splitlines() if "=" in line)
        region = {key: int(raw[name]) for key, name in [("x", "X"), ("y", "Y"), ("width", "WIDTH"), ("height", "HEIGHT")]}
        if region["width"] < 80 or region["height"] < 60: continue
        try: app = command("getwindowclassname", str(window))
        except subprocess.CalledProcessError:
            try:
                pid = int(command("getwindowpid", str(window)))
                app = pathlib.Path(f"/proc/{pid}/comm").read_text().strip()
            except (ValueError, OSError, subprocess.SubprocessError): app = "app"
        title = command("getwindowname", str(window))
        windows.append({"id": window, "app": app[:120] or "app", "title": title[:500] or "Untitled window", "region": region})
    except (KeyError, ValueError, OSError, subprocess.SubprocessError): continue
print(json.dumps(windows))
`;
      const result = await run(`python3 -c ${quote(script)}`);
      if (result.exitCode !== 0) throw new Error("The VM could not enumerate its windows.");
      const windows = JSON.parse(result.stdout);
      if (!Array.isArray(windows)) throw new Error("The VM returned an invalid window list.");
      const seen = new Set();
      return windows.slice(0, 128).filter((window) => {
        if (!window || !Number.isSafeInteger(window.id) || window.id <= 0 || window.id > 0xffffffff || seen.has(window.id)
          || typeof window.app !== "string" || typeof window.title !== "string" || !window.region
          || !["x", "y", "width", "height"].every((key) => Number.isSafeInteger(window.region[key]))
          || window.region.width < 80 || window.region.height < 60) return false;
        seen.add(window.id);
        return true;
      });
    },
    async focus(id) {
      const result = await run(`xdotool windowactivate --sync ${windowId(id)} 2>/dev/null || xdotool windowraise ${windowId(id)} windowfocus --sync ${windowId(id)}`);
      if (result.exitCode !== 0) throw new Error("The selected window could not be focused.");
    },
    async screenshot(region, { maxWidth, windowId: targetId } = {}) {
      const file = `${directory}/shot-${randomUUID().slice(0, 8)}.png`;
      const resize = maxWidth && region.width > maxWidth ? ` -resize ${integer(maxWidth)}x` : "";
      const geometry = `${integer(region.width)}x${integer(region.height)}+${integer(region.x)}+${integer(region.y)}`;
      // Never use -screen for an approved window: it includes overlapping windows.
      // Unavailable/occluded drawable pixels may be blank, which is safe to withhold.
      const drawable = targetId === undefined ? "root" : windowId(targetId);
      try {
        const result = await run(`mkdir -p ${quote(directory)} && import -silent -window ${drawable} -crop ${geometry} +repage${resize} png:${quote(file)} && identify -format '%w %h' ${quote(file)}`);
        if (result.exitCode !== 0) throw new Error(result.stderr.trim().slice(0, 300) || "The screenshot failed.");
        const [width, height] = result.stdout.trim().split(/\s+/).map(Number);
        if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 8192)) throw new Error("The VM returned an invalid screenshot size.");
        const png = await machine.read(file, timeoutMs);
        if (!png.byteLength || png.byteLength > 16 * 1024 * 1024) throw new Error("The screenshot is empty or too large.");
        return { png, width, height };
      } finally { await run(`rm -f ${quote(file)}`).catch(() => {}); }
    },
    interruptibleInput: true,
    async accessibility(region, { observationId, windowId: targetId }) {
      const result = await callWorker({ operation: "observe", id: randomUUID(), observationId, region, ...(targetId === undefined ? {} : { windowId: targetId }) });
      return Array.isArray(result.elements) ? result : { elements: [], capability: "unavailable" };
    },
    async input(steps, { windowId: targetId, observationId, signal } = {}) {
      signal?.throwIfAborted();
      const id = randomUUID();
      // Cancellation uses an independent worker connection and can interrupt an
      // in-flight provider command. The worker remembers cancel-before-start.
      const cancel = () => { void rpc({ operation: "cancel", id }).catch(() => {}); };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        await bootstrap();
        signal?.throwIfAborted();
        const result = await callWorker({ operation: "input", id, steps, timeoutMs, ...(targetId === undefined ? {} : { windowId: windowId(targetId) }), ...(observationId ? { observationId } : {}) });
        return { completed: result.completed ?? 0, attempted: result.attempted !== false, ...(result.error ? { error: result.error } : {}) };
      } finally { signal?.removeEventListener("abort", cancel); }
    },
  };
}
