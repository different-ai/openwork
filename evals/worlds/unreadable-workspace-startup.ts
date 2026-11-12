import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { SkipError, type Seed } from "@openwork/env";
import { bootServer, stopChild } from "./openwork-server-cli.ts";

/** How long the world waits for the server to report its port. */
export const STARTUP_BUDGET_MS = 30_000;

/** The real server, started on a workspace whose settings file can never be
 * read. A named pipe with no writer blocks a read forever, the way a
 * cloud-offloaded file does when it cannot be downloaded. No engine. */
export async function unreadableWorkspaceStartup(seed: Seed) {
  if (process.platform === "win32") throw new SkipError("run where mkfifo exists (not Windows)");
  const scratch = seed.tmpPath("unreadable-workspace-startup");
  const home = join(scratch, "home");
  const unreadable = join(scratch, "unreadable");
  const readable = join(scratch, "readable");
  await mkdir(home, { recursive: true });
  await mkdir(unreadable, { recursive: true });
  execFileSync("mkfifo", [join(unreadable, "opencode.jsonc")]);

  // The spec may run inside an OpenWork or OpenCode session; none of its
  // variables may reach the isolated server.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCODE") && !key.startsWith("OPENWORK_")));
  const env = {
    ...inherited,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
  };
  const token = "unreadable-workspace-token";
  let output = "";
  const startedAt = Date.now();
  const booted = bootServer(env, token, unreadable, (chunk) => { output += chunk; });
  const base = await Promise.race([
    booted.listening.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), STARTUP_BUDGET_MS)),
  ]);
  const startupMs = Date.now() - startedAt;

  const request = async (method: string, path: string, body?: unknown) => {
    const sentAt = Date.now();
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "x-openwork-host-token": `${token}-host`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, ms: Date.now() - sentAt, text: await response.text() };
  };

  return {
    listening: base !== null,
    startupMs,
    readable,
    output: () => output,
    request,
    async [Symbol.asyncDispose]() {
      await stopChild(booted.child);
      await rm(scratch, { recursive: true, force: true });
    },
  };
}
