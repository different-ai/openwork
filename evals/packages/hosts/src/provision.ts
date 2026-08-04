import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { checkedExec, defaultDaytonaExec } from "./daytona.ts";
import type { DaytonaExec, DaytonaExecResult } from "./daytona.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const DESKTOP_READY_TIMEOUT_MS = 300_000;
const INSTALL_TIMEOUT_MS = 25 * 60 * 1_000;
const SERVER_SCRIPT_TIMEOUT_MS = 20 * 60 * 1_000;
const HTTPS_URL = /https:\/\/[^\s"'<>)]+/;
const DEN_WEB_PORT = 3005;
const DEN_API_PORT = 8788;

export interface ProvisionExecOptions {
  exec?: DaytonaExec;
}

export interface DesktopSandboxOptions {
  ref: string;
  name: string;
  reuse?: string;
  snapshot?: string;
  /**
   * Mount the shared eval secrets volume. Off by default: `pnpm install` runs
   * lifecycle scripts from the checked-out ref, so mounting provider keys next
   * to an untrusted ref hands them to it. Signed-in org desktops can only pick
   * the org's own models anyway, and driver-side vision keys never live here —
   * so nothing in the connector room needs this.
   */
  secrets?: boolean;
  log?: (line: string) => void;
}

export interface DesktopSandbox {
  sandbox: string;
  created: boolean;
}

export interface DenSandboxOptions {
  ref: string;
  reuse?: string;
  repoRoot?: string;
  log?: (line: string) => void;
}

export interface DenSandbox {
  sandbox: string;
  apiUrl: string;
  webUrl: string;
  created: boolean;
}

export interface MockOnSandboxOptions {
  sandbox: string;
  port?: number;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
}

export interface MockOnSandbox {
  url: string;
}

export interface ConnectorSpecEnv {
  denApiUrl: string;
  denWebUrl: string;
  sandboxA: string;
  sandboxB: string;
  mockUrl: string;
  ref: string;
  created: string[];
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outputTail(result: DaytonaExecResult): string {
  return `${result.stdout}${result.stderr}`.trim().slice(-2_000);
}

function textTail(text: string): string {
  return text.trim().slice(-4_000);
}

function firstHttpsUrl(text: string): string | null {
  const match = HTTPS_URL.exec(text);
  return match ? match[0].replace(/[.,;:]+$/, "") : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function timedStep<T>(log: (line: string) => void, name: string, action: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  log(`==> ${name}...`);
  try {
    const result = await action();
    log(`==> ${name} done (${Date.now() - startedAt}ms)`);
    return result;
  } catch (error) {
    log(`==> ${name} failed (${Date.now() - startedAt}ms)`);
    throw error;
  }
}

/**
 * daytona exec joins its trailing args with spaces, so a multi-word command
 * must travel as ONE argument or `bash -lc` receives only the first word and
 * the rest leaks into the remote login shell.
 */
async function execInSandbox(
  exec: DaytonaExec,
  sandbox: string,
  script: string,
  opts: { timeoutMs?: number; context: string },
): Promise<DaytonaExecResult> {
  if (script.includes("'")) throw new Error(`Remote script for ${opts.context} must not contain single quotes.`);
  return checkedExec(exec, ["exec", sandbox, "--", `bash -lc '${script}'`], opts.context, { timeoutMs: opts.timeoutMs });
}

/**
 * A ref travels into a remote double-quoted shell word AND into a file the
 * operator is told to `source`, so `$(...)`, a quote, or a newline in it is
 * remote code execution. Refuse anything outside git's own safe alphabet here
 * rather than escaping it correctly at each site forever.
 */
function assertSafeRef(ref: string): string {
  const value = ref.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) {
    throw new Error(`Unsafe git ref ${JSON.stringify(ref)}: only letters, digits and . _ / - are allowed, and it may not start with "-".`);
  }
  return value;
}

function snapshotId(output: string, name: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`Snapshot gate failed: daytona snapshot list returned invalid JSON: ${messageText(error)}. Output tail: ${textTail(output)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Snapshot gate failed: daytona snapshot list did not return an array. Output tail: ${textTail(output)}`);
  }
  for (const entry of parsed) {
    if (isRecord(entry) && entry.name === name && typeof entry.id === "string" && entry.id.length > 0) return entry.id;
  }
  return null;
}

function sandboxTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

async function waitForExecReady(exec: DaytonaExec, sandbox: string): Promise<void> {
  const deadline = Date.now() + DESKTOP_READY_TIMEOUT_MS;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      await execInSandbox(exec, sandbox, "true", { timeoutMs: 30_000, context: `sandbox exec-ready gate for ${sandbox}` });
      return;
    } catch (error) {
      lastError = messageText(error);
    }
    await delay(5_000);
  }
  throw new Error(`Sandbox exec-ready gate failed for ${sandbox} after 300s. Last output: ${lastError}`);
}

function lastNonemptyLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
}

export async function provisionDesktopSandbox(options: DesktopSandboxOptions & ProvisionExecOptions): Promise<DesktopSandbox> {
  const exec = options.exec ?? defaultDaytonaExec;
  const log = options.log ?? console.error;
  const ref = assertSafeRef(options.ref);
  const reused = options.reuse?.trim() || "";
  let sandbox = reused;

  await timedStep(log, "sandbox gate", async () => {
    if (reused) {
      await exec(["sandbox", "start", reused], { timeoutMs: 60_000 });
    } else {
      const snapshot = options.snapshot ?? "openwork-eval-vnc";
      const listed = await checkedExec(exec, ["snapshot", "list", "-f", "json"], "snapshot gate", { timeoutMs: 60_000 });
      const id = snapshotId(listed.stdout, snapshot);
      if (!id) {
        throw new Error(`Snapshot gate failed: snapshot ${snapshot} is missing. Output tail: ${outputTail(listed)}`);
      }
      sandbox = `openwork-connector-${options.name}-${sandboxTimestamp()}`;
      await checkedExec(
        exec,
        [
          "create",
          "--name", sandbox,
          "--snapshot", id,
          ...(options.secrets === true ? ["--volume", "openwork-eval-secrets:/daytona-secrets"] : []),
          "--auto-stop", "60",
          "--public",
          "--target", "us",
        ],
        `sandbox creation gate for ${sandbox}`,
        { timeoutMs: 300_000 },
      );
      log(`==> desktop sandbox created: ${sandbox}`);
    }
    await waitForExecReady(exec, sandbox);
  });

  await timedStep(log, "checkout gate", async () => {
    const result = await execInSandbox(
      exec,
      sandbox,
      // Check out the REQUESTED ref, not FETCH_HEAD: a raw-sha fetch was
      // observed leaving FETCH_HEAD stale, silently running the wrong code —
      // and servers may refuse raw-sha fetches outright, so fall back to a
      // full fetch and prefer the remote-tracking ref over any stale local.
      `set -e; cd /workspace; git fetch origin "${ref}" 2>/dev/null || git fetch origin; git checkout --detach "origin/${ref}" 2>/dev/null || git checkout --detach "${ref}" 2>/dev/null || git checkout --detach FETCH_HEAD; git rev-parse --short=12 HEAD`,
      { timeoutMs: 120_000, context: `checkout gate for ${sandbox}` },
    );
    const sha = lastNonemptyLine(result.stdout);
    if (!sha) throw new Error(`Checkout gate failed for ${sandbox}: git did not print a resolved sha. Output tail: ${outputTail(result)}`);
    const wantsSha = /^[0-9a-f]{7,40}$/.test(ref);
    if (wantsSha && !sha.startsWith(ref.slice(0, 12)) && !ref.startsWith(sha)) {
      throw new Error(`Checkout gate failed for ${sandbox}: asked for ${ref} but HEAD is ${sha}.`);
    }
    log(`==> checkout resolved ${sha}`);
  });

  await timedStep(log, "install gate", async () => {
    await execInSandbox(
      exec,
      sandbox,
      "cd /workspace; pnpm install --store-dir /workspace/.openwork-daytona/pnpm-store",
      { timeoutMs: INSTALL_TIMEOUT_MS, context: `install gate for ${sandbox}` },
    );
  });

  await timedStep(log, "cleanup and disk gate", async () => {
    const result = await execInSandbox(
      exec,
      sandbox,
      "rm -rf /workspace/.openwork-daytona/profiles /tmp/openwork-* 2>/dev/null; df -P /workspace | tail -1",
      { timeoutMs: 60_000, context: `cleanup and disk gate for ${sandbox}` },
    );
    const dfLine = lastNonemptyLine(result.stdout);
    const useField = dfLine.split(/\s+/).find((field) => /^\d+%$/.test(field));
    if (!useField) {
      throw new Error(`Cleanup and disk gate failed for ${sandbox}: could not parse Use% from ${JSON.stringify(dfLine)}.`);
    }
    const used = Number.parseInt(useField, 10);
    if (used > 85) {
      const sizes = await execInSandbox(
        exec,
        sandbox,
        "du -sh /workspace/node_modules /workspace/.openwork-daytona/pnpm-store 2>&1 || true",
        { timeoutMs: 60_000, context: `disk usage detail for ${sandbox}` },
      );
      throw new Error(`Cleanup and disk gate failed for ${sandbox}: workspace is ${useField} used. df: ${dfLine}\n${outputTail(sizes)}`);
    }
  });

  await timedStep(log, "display gate", async () => {
    const result = await execInSandbox(
      exec,
      sandbox,
      "bash /workspace/.devcontainer/start-daytona-vnc.sh >/tmp/vnc.log 2>&1; sleep 2; pgrep -f Xvfb >/dev/null && echo XVFB_OK || echo XVFB_FAIL",
      { timeoutMs: 60_000, context: `display gate for ${sandbox}` },
    );
    if (!result.stdout.includes("XVFB_OK")) {
      throw new Error(`Display gate failed for ${sandbox}: expected XVFB_OK. Output tail: ${outputTail(result)}`);
    }
  });

  await timedStep(log, "browser hop gate", async () => {
    // Chromium launched inside a pipe-stdin exec session TERMs the whole
    // session as it starts (exit 143 at ~2.5s; the same script survives under
    // a TTY). So nothing may run as a child of the session: both halves are
    // fully detached the way the mock and Vite gates are, and the proof is
    // read back by clean, childless polls.
    const detachScript = `rm -f /tmp/xdgtest.log; python3 - <<PYEOF
import subprocess
log = open("/tmp/xdgtest.log", "ab", buffering=0)
subprocess.Popen(["python3", "-m", "http.server", "18099", "--bind", "127.0.0.1"], stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
subprocess.Popen(["bash", "-lc", "sleep 1; export DISPLAY=:99; xdg-open http://127.0.0.1:18099/xdg-open-proof"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
PYEOF
echo detached`;
    await execInSandbox(exec, sandbox, detachScript, { timeoutMs: 30_000, context: `browser hop detach for ${sandbox}` });

    const deadline = Date.now() + 60_000;
    let seen = false;
    while (Date.now() < deadline) {
      const probe = await execInSandbox(
        exec,
        sandbox,
        "grep -q xdg-open-proof /tmp/xdgtest.log 2>/dev/null && echo XDG_OPEN_WORKS || echo XDG_WAITING",
        { timeoutMs: 15_000, context: `browser hop probe for ${sandbox}` },
      );
      if (probe.stdout.includes("XDG_OPEN_WORKS")) {
        seen = true;
        break;
      }
      await delay(3_000);
    }
    await execInSandbox(
      exec,
      sandbox,
      "pkill -f \"[h]ttp.server 18099\" >/dev/null 2>&1; pkill -f \"[c]hromium\" >/dev/null 2>&1; rm -f /tmp/xdgtest.log; true",
      { timeoutMs: 15_000, context: `browser hop cleanup for ${sandbox}` },
    ).catch(() => undefined);
    if (!seen) {
      throw new Error(`Browser hop gate failed for ${sandbox}: xdg-open never delivered a request (no browser reachable from the OAuth connect flow).`);
    }
  });

  await timedStep(log, "first boot gate", async () => {
    // A sandbox's first Electron boot pays sidecar prepare, the
    // openwork-server tsc build, and the engine cold start. Paid INSIDE a
    // spec, that bill starved the tool-call phase past its window while every
    // UI assertion still passed. Boot once into a throwaway profile, wait for
    // CDP, tear it down — after this the room behaves like a warm machine.
    const detachScript = `python3 - <<PYEOF
import subprocess
log = open("/tmp/warmup-electron.log", "ab", buffering=0)
subprocess.Popen(["bash", "-lc", "cd /workspace && env OPENWORK_ELECTRON_USERDATA=/tmp/warmup-profile OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=9825 bash .devcontainer/start-daytona-electron.sh"], stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
PYEOF
echo detached`;
    await execInSandbox(exec, sandbox, detachScript, { timeoutMs: 30_000, context: `first boot detach for ${sandbox}` });
    const deadline = Date.now() + 420_000;
    let last = "not attempted";
    let ready = false;
    while (Date.now() < deadline) {
      const probe = await execInSandbox(
        exec,
        sandbox,
        "curl -s --max-time 5 http://127.0.0.1:9825/json/version || echo CDP_DOWN",
        { timeoutMs: 15_000, context: `first boot probe for ${sandbox}` },
      ).catch((error) => ({ stdout: messageText(error), stderr: "", code: 1 }));
      last = probe.stdout.trim().slice(0, 200);
      if (last.includes("Browser")) {
        ready = true;
        break;
      }
      await delay(5_000);
    }
    await execInSandbox(
      exec,
      sandbox,
      "pkill -f \"[e]lectron\" >/dev/null 2>&1; pkill -f \"[o]pencode\" >/dev/null 2>&1; sleep 1; rm -rf /tmp/warmup-profile; true",
      { timeoutMs: 30_000, context: `first boot cleanup for ${sandbox}` },
    ).catch(() => undefined);
    if (!ready) {
      const bootLog = await execInSandbox(
        exec,
        sandbox,
        "tail -60 /tmp/warmup-electron.log 2>&1 || true",
        { timeoutMs: 30_000, context: `first boot log for ${sandbox}` },
      ).catch(() => null);
      throw new Error(`First boot gate failed for ${sandbox}: CDP never answered on 9825. Last probe: ${last}. Log tail:\n${bootLog ? outputTail(bootLog) : "unavailable"}`);
    }
  });

  await timedStep(log, "Vite prewarm gate", async () => {
    const detachScript = `cd /workspace; python3 - <<PYEOF
import subprocess
log = open("/tmp/vite-prewarm.log", "ab", buffering=0)
subprocess.Popen(["bash", "-lc", "cd /workspace && pnpm -w dev:ui"], stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
PYEOF
echo detached`;
    await execInSandbox(exec, sandbox, detachScript, { timeoutMs: 30_000, context: `Vite prewarm detach for ${sandbox}` });

    const deadline = Date.now() + 180_000;
    let last = "not attempted";
    while (Date.now() < deadline) {
      try {
        const result = await execInSandbox(
          exec,
          sandbox,
          "curl -s -o /dev/null -w %{http_code} --max-time 5 http://localhost:5173/",
          { timeoutMs: 10_000, context: `Vite prewarm probe for ${sandbox}` },
        );
        last = result.stdout.trim();
        if (last === "200") return;
      } catch (error) {
        last = messageText(error);
      }
      await delay(5_000);
    }
    const viteLog = await execInSandbox(
      exec,
      sandbox,
      "tail -80 /tmp/vite-prewarm.log 2>&1 || true",
      { timeoutMs: 30_000, context: `Vite prewarm log for ${sandbox}` },
    );
    throw new Error(`Vite prewarm gate failed for ${sandbox}: last probe ${last}. Log tail:\n${outputTail(viteLog)}`);
  });

  return { sandbox, created: !reused };
}

interface LocalProcessResult {
  output: string;
  code: number;
}

interface LineWriter {
  push(text: string): void;
  flush(): void;
}

function lineWriter(log: (line: string) => void): LineWriter {
  let pending = "";
  return {
    push(text) {
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) log(line);
    },
    flush() {
      if (pending) log(pending);
      pending = "";
    },
  };
}

function runDenProvisionScript(ref: string, repoRoot: string, log: (line: string) => void): Promise<LocalProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [".devcontainer/test-server-on-daytona.sh", ref, "--seed"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutLines = lineWriter(log);
    const stderrLines = lineWriter(log);
    let output = "";
    let timedOut = false;
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, SERVER_SCRIPT_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      output += text;
      stdoutLines.push(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      output += text;
      stderrLines.push(text);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdoutLines.flush();
      stderrLines.flush();
      if (timedOut) output += `\nTimed out after ${SERVER_SCRIPT_TIMEOUT_MS}ms.`;
      resolve({ output, code: timedOut ? 124 : code ?? 1 });
    });
  });
}

function sandboxFromServerOutput(output: string): string | null {
  let fallback: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    const ready = /Server sandbox ready:\s*(\S+)/.exec(line);
    if (ready?.[1]) return ready[1];
    const creating = /Creating server sandbox:\s*(\S+)/.exec(line);
    if (creating?.[1]) fallback = creating[1];
  }
  return fallback;
}


async function previewUrl(exec: DaytonaExec, sandbox: string, port: number): Promise<string> {
  const result = await checkedExec(
    exec,
    ["preview-url", sandbox, "-p", String(port)],
    `preview URL gate for ${sandbox}:${port}`,
    { timeoutMs: 60_000 },
  );
  const url = firstHttpsUrl(result.stdout);
  if (!url) throw new Error(`Preview URL gate failed for ${sandbox}:${port}: no https URL in output tail: ${outputTail(result)}`);
  return url;
}

async function proveDenSeed(apiUrl: string, webUrl: string, sandbox: string, reused: boolean): Promise<void> {
  const email = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
  const password = process.env.OPENWORK_EVAL_DEMO_PASSWORD ?? "OpenWorkDemo123!";
  const url = `${apiUrl.replace(/\/+$/, "")}/api/auth/sign-in/email`;
  // A freshly-booted stack was observed answering public sign-in with bare
  // 403s for its first ~minute, then recovering on its own — so the window is
  // generous, and a failing status keeps its body so the failure names itself.
  // (That body once read MISSING_OR_NULL_ORIGIN: early boot rejects
  // origin-less POSTs, and every real client sends Origin — so must we.)
  const deadline = Date.now() + 120_000;
  let last = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", origin: webUrl },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 200) return;
      const body = await response.text().catch(() => "");
      last = `HTTP ${response.status} ${body.slice(0, 300)}`.trim();
    } catch (error) {
      last = messageText(error);
    }
    await delay(2_000);
  }
  if (reused) {
    throw new Error(`Den seed proof failed for reused sandbox ${sandbox}: the Den has no seeded org. Omit --reuse-den to provision a seeded Den sandbox. Last: ${last}`);
  }
  throw new Error(`Den seed proof failed for ${sandbox}: ${email} could not sign in at ${apiUrl}. Last: ${last}`);
}

export async function provisionDenSandbox(options: DenSandboxOptions & ProvisionExecOptions): Promise<DenSandbox> {
  const exec = options.exec ?? defaultDaytonaExec;
  const log = options.log ?? console.error;
  const ref = assertSafeRef(options.ref);
  const reused = options.reuse?.trim() || "";
  let sandbox: string;
  let webUrl: string;
  let apiUrl: string;

  if (reused) {
    sandbox = reused;
    [webUrl, apiUrl] = await timedStep(log, "Den preview URL gate", () => Promise.all([
      previewUrl(exec, sandbox, DEN_WEB_PORT),
      previewUrl(exec, sandbox, DEN_API_PORT),
    ]));
  } else {
    const result = await timedStep(log, "Den provisioning script", () => runDenProvisionScript(ref, options.repoRoot ?? REPO_ROOT, log));
    if (result.code !== 0) {
      throw new Error(`Den provisioning script gate failed with exit ${result.code}. Output tail:\n${textTail(result.output)}`);
    }
    const parsedSandbox = sandboxFromServerOutput(result.output);
    if (!parsedSandbox) throw new Error(`Den provisioning script output is missing sandbox. Output tail:\n${textTail(result.output)}`);
    sandbox = parsedSandbox;
    // URLs come from daytona for THIS sandbox, never from the script's stdout:
    // the ref being provisioned controls that stream, so a spoofed
    // "DEN_API_URL=https://attacker" line would receive the demo credentials
    // the sign-in proof posts moments later.
    [webUrl, apiUrl] = await timedStep(log, "Den preview URL gate", () => Promise.all([
      previewUrl(exec, parsedSandbox, DEN_WEB_PORT),
      previewUrl(exec, parsedSandbox, DEN_API_PORT),
    ]));
  }

  await timedStep(log, "Den seeded-org proof", () => proveDenSeed(apiUrl, webUrl, sandbox, Boolean(reused)));
  return { sandbox, apiUrl, webUrl, created: !reused };
}

export async function startMockOnSandbox(options: MockOnSandboxOptions & ProvisionExecOptions): Promise<MockOnSandbox> {
  const exec = options.exec ?? defaultDaytonaExec;
  const log = options.log ?? console.error;
  const fetchImpl = options.fetchImpl ?? fetch;
  const port = options.port ?? 3979;
  const url = await timedStep(log, "mock preview URL gate", () => previewUrl(exec, options.sandbox, port));

  await timedStep(log, "mock process cleanup", async () => {
    await execInSandbox(
      exec,
      options.sandbox,
      "pkill -f mock-oauth-mcp-server || true",
      { timeoutMs: 30_000, context: `mock process cleanup for ${options.sandbox}` },
    ).catch(() => undefined);
  });

  await timedStep(log, "mock process detach", async () => {
    const detachScript = `cd /workspace; python3 - <<PYEOF
import subprocess
log = open("/tmp/mock-mcp.log", "ab", buffering=0)
subprocess.Popen(["bash", "-lc", "cd /workspace && env HOST=0.0.0.0 PORT=${port} ISSUER=${url} AUTO_APPROVE=1 node scripts/mock-oauth-mcp-server.mjs"], stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
PYEOF
echo detached`;
    await execInSandbox(exec, options.sandbox, detachScript, { timeoutMs: 30_000, context: `mock process detach for ${options.sandbox}` });
  });

  await timedStep(log, "mock health gate", async () => {
    const deadline = Date.now() + 60_000;
    let last = "not attempted";
    while (Date.now() < deadline) {
      let body: unknown = null;
      let responseOk = false;
      try {
        const response = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(5_000) });
        body = await response.json();
        responseOk = response.ok;
        if (!response.ok) last = `HTTP ${response.status}`;
      } catch (error) {
        last = messageText(error);
      }
      if (responseOk && isRecord(body) && body.ok === true) {
        const issuer = typeof body.issuer === "string" ? body.issuer : JSON.stringify(body.issuer);
        if (issuer !== url) throw new Error(`Mock issuer gate failed: health reported ${issuer}, expected ${url}.`);
        return;
      }
      await delay(2_000);
    }
    const mockLog = await execInSandbox(
      exec,
      options.sandbox,
      "tail -80 /tmp/mock-mcp.log 2>&1 || true",
      { timeoutMs: 30_000, context: `mock health log for ${options.sandbox}` },
    );
    throw new Error(`Mock health gate failed at ${url}. Last: ${last}. Log tail:\n${outputTail(mockLog)}`);
  });

  return { url };
}

function deletionOutput(result: DaytonaExecResult): string {
  return `${result.stderr}\n${result.stdout}`.trim();
}

function deletionNotFound(text: string): boolean {
  return /not found|does not exist|no sandbox/i.test(text);
}

export async function deleteSandboxes(
  ids: string[],
  options: ProvisionExecOptions & { log?: (line: string) => void } = {},
): Promise<void> {
  const exec = options.exec ?? defaultDaytonaExec;
  const log = options.log ?? console.error;
  for (const id of ids) {
    log(`==> deleting sandbox ${id}...`);
    // The CLI has no --yes; answering its confirmation prompt on stdin works,
    // and a promptless future CLI would simply ignore the input.
    const result = await exec(["delete", id], { timeoutMs: 60_000, input: "y\n" });
    const output = deletionOutput(result);
    if (result.code !== 0 && deletionNotFound(output)) {
      log(`==> sandbox ${id} not found; continuing`);
      continue;
    }
    if (result.code !== 0) throw new Error(`Sandbox deletion gate failed for ${id} with exit ${result.code}. Output tail: ${textTail(output)}`);
    log(`==> deleted sandbox ${id}`);
  }
}

const ENV_HEADER_PREFIX = "# provisioned for org-connector-two-members";
const ENV_REF_MARKER = "; ref=";
const ENV_CREATED_PREFIX = "# provision-created=";

/** First line starting with prefix, minus the prefix. Linear, no backtracking. */
function commentLine(content: string, prefix: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith(prefix)) return line.slice(prefix.length);
  }
  return null;
}

/** POSIX single-quoting: the generated file is `source`d, so an unquoted
 * value like `$(cmd)` would execute on the operator's machine. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll(`'"'"'`, "'");
  }
  return value;
}

export function renderConnectorSpecEnv(facts: ConnectorSpecEnv): string {
  assertSafeRef(facts.ref);
  return [
    `${ENV_HEADER_PREFIX} — generated ${new Date().toISOString()}${ENV_REF_MARKER}${facts.ref}`,
    `${ENV_CREATED_PREFIX}${facts.created.join(",")}`,
    "OPENWORK_EVAL_APP_SPECS=1",
    "OPENWORK_EVAL_CONNECTOR_SPEC=1",
    `OPENWORK_EVAL_DEN_API_URL=${shellQuote(facts.denApiUrl)}`,
    `OPENWORK_EVAL_DEN_WEB_URL=${shellQuote(facts.denWebUrl)}`,
    `OPENWORK_EVAL_DAYTONA_SANDBOX_A=${shellQuote(facts.sandboxA)}`,
    `OPENWORK_EVAL_DAYTONA_SANDBOX_B=${shellQuote(facts.sandboxB)}`,
    `OPENWORK_EVAL_CONNECTOR_MOCK_PUBLIC_URL=${shellQuote(facts.mockUrl)}`,
    "OPENWORK_EVAL_MODEL=big-pickle",
    "",
  ].join("\n");
}

export function parseConnectorSpecEnv(content: string): ConnectorSpecEnv {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator), unquote(line.slice(separator + 1)));
  }
  function required(name: string): string {
    const value = values.get(name);
    if (value === undefined || value.length === 0) throw new Error(`Missing ${name} in connector spec env.`);
    return value;
  }

  required("OPENWORK_EVAL_APP_SPECS");
  required("OPENWORK_EVAL_CONNECTOR_SPEC");
  required("OPENWORK_EVAL_MODEL");
  // Header comments are read by line scan, not regex: `.*` before a literal
  // backtracks polynomially on adversarial input (CodeQL js/polynomial-redos).
  const header = commentLine(content, ENV_HEADER_PREFIX);
  const refAt = header ? header.lastIndexOf(ENV_REF_MARKER) : -1;
  if (refAt < 0) throw new Error("Missing ref in connector spec env header.");
  const ref = header?.slice(refAt + ENV_REF_MARKER.length) ?? "";
  if (!ref) throw new Error("Missing ref in connector spec env header.");
  const createdText = commentLine(content, ENV_CREATED_PREFIX);
  if (createdText === null) throw new Error("Missing provision-created in connector spec env header.");

  return {
    denApiUrl: required("OPENWORK_EVAL_DEN_API_URL"),
    denWebUrl: required("OPENWORK_EVAL_DEN_WEB_URL"),
    sandboxA: required("OPENWORK_EVAL_DAYTONA_SANDBOX_A"),
    sandboxB: required("OPENWORK_EVAL_DAYTONA_SANDBOX_B"),
    mockUrl: required("OPENWORK_EVAL_CONNECTOR_MOCK_PUBLIC_URL"),
    ref,
    created: createdText.split(",").map((id) => id.trim()).filter(Boolean),
  };
}
