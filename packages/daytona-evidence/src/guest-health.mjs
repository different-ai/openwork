// Runs inside an owned guest. Only allowlisted facts leave the VM, never raw logs,
// request headers, access.json, process command lines, or service environments.
import { readFile, writeFile, open, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const root = "/opt/openwork-preview";
const command = (name, args) => {
  try { return execFileSync(name, args, { encoding: "utf8", timeout: 1_000, maxBuffer: 32_768, stdio: ["ignore", "pipe", "pipe"] }); }
  catch { return ""; }
};
const read = (path) => readFile(path, "utf8").catch(() => "");
const parse = (value) => { try { const data = JSON.parse(value); return data && typeof data === "object" && !Array.isArray(data) ? data : {}; } catch { return {}; } };
const port = (value) => {
  try { const url = new URL(value); return url.protocol === "http:" && url.hostname === "127.0.0.1" ? Number(url.port) : 0; }
  catch { return 0; }
};
const services = parse(await read(`${root}/services.json`));
let access = parse(await read(`${root}/access.json`));
if (process.env.OPENWORK_DAYTONA_HEALTH_PREPARE === "1" && (!access.token || Date.parse(access.expiresAt) <= Date.now())) {
  access = { token: randomBytes(32).toString("base64url"), expiresAt: new Date(Date.now() + 300_000).toISOString() };
  await writeFile(`${root}/access.json`, JSON.stringify(access), { mode: 0o600 });
}
const chromePort = port(services.cdp);
async function probe(url, cookie = false) {
  try {
    const response = await fetch(url, { headers: cookie ? { cookie: `__Host-openwork-preview=${access.token}` } : {}, signal: AbortSignal.timeout(2_000) });
    // A 200 HTML provider page is not a CDP endpoint. Do not return its private body.
    const chunks = [];
    let bytes = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (bytes < 8_192) {
          const next = await reader.read();
          if (next.done) break;
          const chunk = next.value.subarray(0, 8_192 - bytes);
          chunks.push(chunk); bytes += chunk.length;
        }
      } finally { await reader.cancel().catch(() => {}); }
    }
    const body = parse(Buffer.concat(chunks).toString("utf8"));
    return { status: response.status, cdp: typeof body?.webSocketDebuggerUrl === "string" && typeof body?.Browser === "string" };
  } catch { return { status: 0, cdp: false }; }
}
const [chrome, gateway] = await Promise.all([
  chromePort ? probe(`http://127.0.0.1:${chromePort}/json/version`) : Promise.resolve({ status: 0, cdp: false }),
  probe("http://127.0.0.1:8081/json/version", true),
]);
const units = ["openwork-evidence", "openwork-evidence-cdp", "openwork-evidence-gateway"].map((name) => {
  const state = command("systemctl", ["show", name, "--property=ActiveState,SubState,Result,ExecMainStatus"]);
  const value = (key, allowed) => { const found = state.match(new RegExp(`^${key}=([^\\n]+)$`, "m"))?.[1]; return allowed.includes(found) ? found : "unknown"; };
  return { name, active: value("ActiveState", ["active", "inactive", "failed", "activating", "deactivating"]),
    sub: value("SubState", ["running", "dead", "failed", "start", "stop", "exited"]),
    result: value("Result", ["success", "exit-code", "signal", "core-dump", "oom-kill", "timeout"]),
    exit: Number(state.match(/^ExecMainStatus=([0-9]+)$/m)?.[1] ?? -1) };
});
const environment = command("systemctl", ["show", "openwork-evidence-cdp", "--property=Environment"]);
const upstreamPort = Number(environment.match(/(?:^|[\s=])OPENWORK_PREVIEW_UPSTREAM_PORT=([0-9]+)/)?.[1] ?? 0);
const selectedPorts = [chromePort, upstreamPort, 8080, 8081];
const listeners = command("ss", ["-H", "-ltn"]).split("\n").flatMap((line) => {
  const value = Number(line.trim().split(/\s+/)[3]?.match(/:([0-9]+)$/)?.[1]);
  return selectedPorts.includes(value) && value > 0 ? [value] : [];
});
// Minimal Ubuntu images need not include iproute2/ss. procfs still tells us
// which selected ports are listening without exposing processes or addresses.
for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
  for (const line of (await read(path)).split("\n").slice(1)) {
    const columns = line.trim().split(/\s+/);
    const value = Number.parseInt(columns[1]?.split(":")[1] ?? "", 16);
    if (columns[3] === "0A" && selectedPorts.includes(value) && value > 0) listeners.push(value);
  }
}
// Journals/logs can contain credentials. Reduce bounded tails to known event
// categories instead of attempting to redact arbitrary private prose.
const eventPatterns = { refused: /ECONNREFUSED|Connection refused/i, addressInUse: /EADDRINUSE|Address already in use/i,
  oom: /out of memory|oom[-_ ]kill|Killed process.*chrom|memory cgroup out of memory/i,
  crash: /segmentation fault|segfault|core dumped|SIGSEGV|SIGABRT|chrome.*crash/i,
  exited: /Main process exited|Failed with result|Target closed|browser.*disconnected/i };
const events = (text) => Object.entries(eventPatterns).filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
const journals = units.map(({ name }) => ({ name, events: events(command("journalctl", ["-u", name, "--no-pager", "-n", "60", "-o", "cat"])) }));
async function tail(path) {
  let file;
  try {
    file = await open(path, "r");
    const size = (await file.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, 16_384));
    await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return buffer.toString("utf8");
  } catch { return ""; }
  finally { await file?.close(); }
}
const surfaces = "/workspace/evals/results/.surfaces";
const browserLogs = [];
for (const pid of (await readdir(surfaces).catch(() => [])).filter((name) => /^[0-9]+$/.test(name)).slice(-8)) {
  for (const name of (await readdir(`${surfaces}/${pid}`).catch(() => [])).filter((name) => /^evidence-web-[a-zA-Z0-9-]+$/.test(name)).slice(-4)) {
    browserLogs.push(await tail(`${surfaces}/${pid}/${name}/chrome.log`));
  }
}
const browserEvents = events(browserLogs.join("\n"));
const kernelEvents = events(command("journalctl", ["-k", "--no-pager", "-n", "80", "-o", "cat"]));
const oomKills = Number((await read("/sys/fs/cgroup/memory.events")).match(/^oom_kill ([0-9]+)$/m)?.[1] ?? -1);
console.log(JSON.stringify({ chrome, gateway, chromePort, upstreamPort, listeners: [...new Set(listeners)], units, journals, browserEvents, kernelEvents, oomKills }));
