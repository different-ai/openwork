import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import {
  TenkiSandbox,
  WaitReadyFailedError,
  type ProcessRunHandle,
  type Session,
} from "@tenkicloud/sandbox";

// Guest layout. Tenki sandboxes run as the `tenki` user with this home directory.
const GUEST_HOME = "/home/tenki";
const GUEST_DIR = `${GUEST_HOME}/openwork`;
const SERVER_BIN = `${GUEST_DIR}/node_modules/.bin/openwork-server`;
const OPENCODE_BIN = `${GUEST_DIR}/bin/opencode`;
const WORKSPACE_DIR = `${GUEST_DIR}/workspace`;

const PROVISION_TIMEOUT_MS = 10 * 60 * 1000;
const HEALTH_DEADLINE_MS = 4 * 60 * 1000;
const SMOKE_DEADLINE_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 30 * 1000;

// Provider keys forwarded into the server environment when set, so the managed
// OpenCode engine can actually run prompts. Never printed or persisted.
const FORWARDED_PROVIDER_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];

interface Config {
  serverVersion: string;
  opencodeVersion: string;
  port: number;
  clientToken: string;
  hostToken: string;
  keepAlive: boolean;
  previewSlug: string | undefined;
}

async function resolveConfig(): Promise<Config> {
  return {
    serverVersion: process.env.OPENWORK_SERVER_VERSION?.trim() || "latest",
    opencodeVersion: process.env.OPENCODE_VERSION?.trim() || (await repoOpencodeVersion()),
    port: resolvePort(),
    clientToken: process.env.OPENWORK_TOKEN?.trim() || randomUUID(),
    hostToken: process.env.OPENWORK_HOST_TOKEN?.trim() || randomUUID(),
    keepAlive: process.env.OPENWORK_TENKI_KEEP_ALIVE === "1",
    previewSlug: process.env.TENKI_PREVIEW_SLUG?.trim() || undefined,
  };
}

function resolvePort(): number {
  const raw = process.env.OPENWORK_PORT?.trim();
  if (!raw) return 8787;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid OPENWORK_PORT: "${raw}"`);
  }
  return port;
}

/** Default OpenCode version comes from the repo-root constants.json pin. */
async function repoOpencodeVersion(): Promise<string> {
  const constantsUrl = new URL("../../../constants.json", import.meta.url);
  const parsed: unknown = JSON.parse(await readFile(constantsUrl, "utf8"));
  return getString(parsed, "opencodeVersion");
}

function getProperty(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null) {
    const record: Record<string, unknown> = Object.fromEntries(Object.entries(value));
    return record[key];
  }
  throw new Error(`expected a JSON object with a "${key}" field`);
}

function getString(value: unknown, key: string): string {
  const found = getProperty(value, key);
  if (typeof found === "string" && found.length > 0) return found;
  throw new Error(`expected a non-empty string "${key}" field`);
}

function firstListItem(value: unknown, key: string): unknown {
  const found = getProperty(value, key);
  if (Array.isArray(found) && found.length > 0) return found[0];
  throw new Error(`expected a non-empty "${key}" array`);
}

function request(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/**
 * Local deadline for guest commands: @tenkicloud/sandbox 0.5.4 declares
 * ExecOptions.timeoutMs but does not apply it, so we enforce one here. On
 * timeout the guest process may keep running, which is fine because the
 * sandbox is terminated right after.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function provisionScript(config: Config): string {
  return `
set -eu
mkdir -p '${GUEST_DIR}/bin' '${WORKSPACE_DIR}'
arch="$(uname -m)"
if [ "$arch" != "x86_64" ]; then
  # The published openwork-server npm package ships a single x86_64 binary.
  echo "unsupported architecture: $arch" >&2
  exit 1
fi
npm install --prefix '${GUEST_DIR}' --no-fund --no-audit 'openwork-server@${config.serverVersion}'
tmpdir="$(mktemp -d)"
asset="opencode-linux-x64-baseline.tar.gz"
curl -fsSL "https://github.com/anomalyco/opencode/releases/download/${config.opencodeVersion}/$asset" -o "$tmpdir/$asset"
tar -xzf "$tmpdir/$asset" -C "$tmpdir"
binary="$(find "$tmpdir" -type f -name opencode | head -n 1)"
test -n "$binary"
install -m 0755 "$binary" '${OPENCODE_BIN}'
rm -rf "$tmpdir"
# The published npm package ships the compiled binary without the executable bit.
chmod +x '${GUEST_DIR}/node_modules/openwork-server/dist/bin/openwork-server'
'${SERVER_BIN}' --version
'${OPENCODE_BIN}' --version
`;
}

function serverEnv(config: Config): Record<string, string> {
  const env: Record<string, string> = {
    OPENWORK_HOST: "0.0.0.0",
    OPENWORK_PORT: String(config.port),
    OPENWORK_TOKEN: config.clientToken,
    OPENWORK_HOST_TOKEN: config.hostToken,
    OPENWORK_APPROVAL_MODE: "auto",
    OPENWORK_CORS_ORIGINS: "*",
    OPENWORK_WORKSPACES: WORKSPACE_DIR,
    OPENWORK_MANAGE_OPENCODE: "1",
    OPENWORK_OPENCODE_BIN: OPENCODE_BIN,
  };
  for (const key of FORWARDED_PROVIDER_KEYS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

function streamLogs(handle: ProcessRunHandle): void {
  const pump = async (stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream): Promise<void> => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let pending = "";
    const emit = (line: string): void => {
      if (line.trim().length > 0) sink.write(`[openwork] ${line}\n`);
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) emit(line);
      }
      emit(pending + decoder.decode());
    } finally {
      reader.releaseLock();
    }
  };
  void pump(handle.stdout, process.stdout).catch(() => undefined);
  void pump(handle.stderr, process.stderr).catch(() => undefined);
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + HEALTH_DEADLINE_MS;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) return;
    } catch {
      // Not reachable yet; the preview URL returns errors until the server listens.
    }
    if (Date.now() > deadline) throw new Error(`server did not become healthy at ${baseUrl}/health`);
    await sleep(2000);
  }
}

async function runSmokeChecks(baseUrl: string, clientToken: string): Promise<void> {
  const unauthenticated = await request(`${baseUrl}/workspaces`);
  if (unauthenticated.status !== 401) {
    throw new Error(`expected unauthenticated /workspaces to return 401, got ${unauthenticated.status}`);
  }

  const auth = { Authorization: `Bearer ${clientToken}` };
  const workspacesResponse = await request(`${baseUrl}/workspaces`, { headers: auth });
  if (!workspacesResponse.ok) {
    throw new Error(`expected authenticated /workspaces to succeed, got ${workspacesResponse.status}`);
  }
  const workspaces: unknown = await workspacesResponse.json();
  const workspaceId = getString(firstListItem(workspaces, "items"), "id");
  console.log(`Workspace registered: ${workspaceId}`);

  // The managed OpenCode engine can finish booting slightly after /health goes
  // green, so retry session creation until the smoke deadline.
  const deadline = Date.now() + SMOKE_DEADLINE_MS;
  let sessionId = "";
  for (;;) {
    const created = await request(`${baseUrl}/w/${workspaceId}/opencode/session`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Tenki sandbox smoke test" }),
    });
    if (created.ok) {
      const payload: unknown = await created.json();
      sessionId = getString(payload, "id");
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(`expected opencode session create to succeed, got ${created.status}`);
    }
    await sleep(3000);
  }
  console.log(`OpenCode session created: ${sessionId}`);

  const fetched = await request(`${baseUrl}/w/${workspaceId}/opencode/session/${sessionId}`, { headers: auth });
  if (!fetched.ok) throw new Error(`expected opencode session get to succeed, got ${fetched.status}`);

  const messages = await request(`${baseUrl}/w/${workspaceId}/opencode/session/${sessionId}/message?limit=10`, {
    headers: auth,
  });
  if (!messages.ok) throw new Error(`expected opencode session messages to succeed, got ${messages.status}`);
}

async function main(): Promise<void> {
  const config = await resolveConfig();
  const sandbox = new TenkiSandbox(); // reads TENKI_API_KEY / TENKI_AUTH_TOKEN

  let pendingCreate: Promise<Session> | undefined;
  let session: Session | undefined;
  let serverHandle: ProcessRunHandle | undefined;
  let shuttingDown = false;

  // Memoized so the signal handlers and the finally block never double-terminate.
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      shuttingDown = true;
      if (serverHandle) await serverHandle.kill().catch(() => undefined);
      const active = session ?? (await pendingCreate?.then(
        (created) => created,
        () => undefined,
      ));
      if (active) {
        await active.closeIfOpen();
        console.log(`Sandbox ${active.id} terminated.`);
      }
    })();
    return shutdownPromise;
  };

  // Installed before create() so Ctrl+C during sandbox creation still cleans up.
  process.once("SIGINT", () => {
    console.log("\nInterrupted; terminating sandbox...");
    void shutdown().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(143));
  });

  try {
    const startedAt = Date.now();
    console.log("Creating Tenki sandbox...");
    pendingCreate = sandbox.create({
      name: "openwork-example",
      cpuCores: 2,
      memoryMb: 4096,
      diskSizeGb: 10,
      allowInbound: true,
      allowOutbound: true,
      maxDurationMs: (config.keepAlive ? 120 : 30) * 60 * 1000,
      idleTimeoutMinutes: config.keepAlive ? 60 : 15,
      tags: ["openwork-example"],
    });
    try {
      session = await pendingCreate;
    } catch (error) {
      // A readiness-wait failure still carries a live session; terminate it.
      if (error instanceof WaitReadyFailedError && error.session) {
        await error.session.closeIfOpen().catch(() => undefined);
      }
      throw error;
    }
    const sandboxReadyMs = Date.now() - startedAt;
    console.log(`Sandbox ${session.id} running (${sandboxReadyMs} ms).`);

    console.log(`Installing openwork-server@${config.serverVersion} and OpenCode ${config.opencodeVersion}...`);
    const provisionStartedAt = Date.now();
    const provision = await withDeadline(
      session.exec("bash", {
        args: ["-c", provisionScript(config)],
        onOutput: (output) => {
          (output.isStderr ? process.stderr : process.stdout).write(output.data);
        },
      }),
      PROVISION_TIMEOUT_MS,
      "provisioning",
    );
    if (provision.exitCode !== 0) {
      throw new Error(`provisioning failed with exit code ${provision.exitCode}`);
    }
    const provisionMs = Date.now() - provisionStartedAt;

    console.log("Starting OpenWork server...");
    const serverStartedAt = Date.now();
    serverHandle = session.run([SERVER_BIN, "--verbose"], { env: serverEnv(config) });
    streamLogs(serverHandle);

    // Surfaces a crashed or terminated server instead of hanging on health
    // polls (or forever in keep-alive mode). Quiet once shutdown started.
    const serverExitMessage: Promise<string> = Promise.resolve(serverHandle).then(
      (result) => `openwork-server exited early with code ${result.exitCode}${result.reason ? ` (${result.reason})` : ""}`,
      (error) => `openwork-server run stream failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    const failOnServerExit = <T>(work: Promise<T>): Promise<T> => {
      const failure = serverExitMessage.then(async (message) => {
        if (shuttingDown) return new Promise<never>(() => {});
        throw new Error(message);
      });
      return Promise.race([work, failure]);
    };

    const exposed = await session.exposePort(config.port, {
      ...(config.previewSlug ? { slug: config.previewSlug } : {}),
    });
    const baseUrl = exposed.previewUrl.replace(/\/+$/, "");
    console.log(`Port ${config.port} exposed at ${baseUrl}`);

    await failOnServerExit(waitForHealth(baseUrl));
    const serverReadyMs = Date.now() - serverStartedAt;

    await failOnServerExit(runSmokeChecks(baseUrl, config.clientToken));
    const totalMs = Date.now() - startedAt;

    console.log("");
    console.log("All checks passed.");
    console.log(`- sandbox ready:  ${sandboxReadyMs} ms`);
    console.log(`- provisioning:   ${provisionMs} ms`);
    console.log(`- server ready:   ${serverReadyMs} ms`);
    console.log(`- total:          ${totalMs} ms`);
    console.log("");
    console.log(`OpenWork URL:  ${baseUrl}`);
    console.log(`Client token:  ${config.clientToken}`);
    console.log(`Host token:    ${config.hostToken}`);
    console.log("Connect the OpenWork desktop app via Add a worker -> Connect remote.");

    if (config.keepAlive) {
      console.log("");
      console.log("Keep-alive mode: press Ctrl+C to terminate the sandbox.");
      await failOnServerExit(
        new Promise<never>(() => {
          // Resolved never; SIGINT/SIGTERM handlers terminate the sandbox.
        }),
      );
    }
  } finally {
    await shutdown();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
