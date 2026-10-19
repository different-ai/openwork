import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { LocalEndpoint } from "./relay.ts";
import type { SshRoute } from "./routes.ts";

export interface SshOptions {
  /** The ssh client and any leading arguments; defaults to the system `ssh`. */
  command?: readonly string[];
  /** How long to wait for the forward to accept connections. */
  readyTimeoutMs?: number;
  signal?: AbortSignal;
}

/** Failure reasons are fixed words: ssh's own output can echo the token-bearing user. */
export type SshFailure = "auth" | "forward-refused" | "network" | "timeout" | "exited" | "aborted";

export class SshForwardError extends Error {
  readonly reason: SshFailure;
  readonly exitCode: number | null;
  constructor(reason: SshFailure, exitCode: number | null = null) {
    super(`SSH forward failed (${reason}${exitCode === null ? "" : `, exit ${exitCode}`})`);
    this.reason = reason;
    this.exitCode = exitCode;
  }
}

function classify(stderr: string): SshFailure {
  if (/permission denied|authentication|auth fail/i.test(stderr)) return "auth";
  if (/open failed|administratively prohibited|forwarding failed|port forwarding/i.test(stderr)) return "forward-refused";
  if (/could not resolve|connection refused|timed out|no route|network is unreachable|connection closed|reset by peer/i.test(stderr)) return "network";
  return "exited";
}

const HOST = /^[a-z0-9.-]{1,253}$/i;
/** Config lines are whitespace-separated; a token with spaces or quotes could inject options. */
const SAFE_WORD = /^[A-Za-z0-9._~+:@=/-]{1,1024}$/;

export function sshConfig(route: SshRoute, knownHosts: string) {
  if (!HOST.test(route.host)) throw new Error("Invalid SSH host");
  if (!SAFE_WORD.test(route.user)) throw new Error("Invalid SSH user");
  const port = route.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid SSH port");
  return [
    "Host sandbox",
    `  HostName ${route.host}`,
    `  Port ${port}`,
    `  User ${route.user}`,
    // Providers authenticate the token in the user name; never offer local keys or prompt.
    "  BatchMode yes",
    "  PubkeyAuthentication no",
    "  IdentityAgent none",
    "  IdentitiesOnly yes",
    // A fresh known-hosts file per forward: the provider token, not a host key, is the trust anchor.
    "  StrictHostKeyChecking accept-new",
    `  UserKnownHostsFile ${knownHosts}`,
    "  GlobalKnownHostsFile /dev/null",
    "  ExitOnForwardFailure yes",
    "  ServerAliveInterval 15",
    "  ServerAliveCountMax 3",
    "  ConnectTimeout 15",
    "  ControlMaster no",
    "  ControlPath none",
    "  LogLevel ERROR",
    "",
  ].join("\n");
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("No free local port");
  return address.port;
}

const accepts = (port: number) => new Promise<boolean>((resolve) => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.setTimeout(1_000);
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("timeout", () => { socket.destroy(); resolve(false); });
  socket.once("error", () => resolve(false));
});

/**
 * Forwards a guest port to `http://127.0.0.1:<port>` over the provider's SSH
 * gateway. The token-bearing user goes in a private config file, never argv,
 * so it is not visible in the process list.
 */
export async function sshForward(route: SshRoute, options: SshOptions = {}): Promise<LocalEndpoint> {
  const dir = await mkdtemp(join(tmpdir(), "ow-sandbox-ssh-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const config = join(dir, "config");
    await writeFile(config, sshConfig(route, join(dir, "known_hosts")), { mode: 0o600 });
    const local = await freePort();
    const target = `${route.target.host ?? "127.0.0.1"}:${route.target.port}`;
    const [command, ...prefix] = options.command ?? ["ssh"];
    const child = spawn(command, [...prefix, "-F", config, "-N", "-T", "-L", `127.0.0.1:${local}:${target}`, "sandbox"], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 4_096) stderr += chunk.toString("utf8"); });
    let exitCode: number | null | undefined;
    const exited = new Promise<void>((resolve) => child.once("exit", (code) => { exitCode = code; resolve(); }));
    child.once("error", () => { exitCode ??= -1; });
    const stop = async () => {
      if (exitCode === undefined) {
        child.kill("SIGTERM");
        if (await Promise.race([exited.then(() => true), delay(2_000, false)]) === false) child.kill("SIGKILL");
        await exited;
      }
      await cleanup();
    };
    const deadline = Date.now() + (options.readyTimeoutMs ?? 30_000);
    try {
      for (;;) {
        if (options.signal?.aborted) throw new SshForwardError("aborted");
        if (exitCode !== undefined) throw new SshForwardError(classify(stderr), exitCode);
        if (await accepts(local)) break;
        if (Date.now() > deadline) throw new SshForwardError("timeout");
        await delay(200);
      }
    } catch (error) { await stop(); throw error; }
    return { url: `http://127.0.0.1:${local}`, [Symbol.asyncDispose]: stop };
  } catch (error) { await cleanup(); throw error; }
}
