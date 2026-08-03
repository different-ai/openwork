import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDaytonaHost } from "./daytona.ts";
import { createLocalHost } from "./local.ts";
import type { DisposableHost, Host } from "./types.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

/** True when this process is itself running inside a Daytona sandbox. */
export function runningInsideSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.DAYTONA_SANDBOX_ID ?? "").trim().length > 0) return true;
  return existsSync("/daytona-secrets") || existsSync("/daytona-artifacts");
}

export async function resolveHost(env: NodeJS.ProcessEnv = process.env): Promise<Host & AsyncDisposable> {
  const sandboxId = env.OPENWORK_EVAL_DAYTONA_SANDBOX?.trim();
  // The Daytona host drives the `daytona` CLI from OUTSIDE a sandbox. When the
  // caller is already inside one, that indirection cannot work — spawn locally,
  // which is the same machine the sandbox host would have targeted anyway.
  if (sandboxId && !runningInsideSandbox(env)) {
    return createDaytonaHost({ sandboxId, repoRoot: REPO_ROOT, log: () => undefined });
  }
  return createLocalHost({ repoRoot: REPO_ROOT, log: () => undefined });
}

/**
 * PLACEMENT, stated rather than inferred.
 *
 * `resolveHost()` reads one ambient env var, so a whole process gets one host:
 * everything local, or everything in one sandbox. A spec that needs the app and
 * the browser in different places — or two desktops in two sandboxes — cannot
 * say so. These factories name a placement, and `desktop({ host })` /
 * `chrome({ host })` take it, so a spec declares its topology instead of
 * inheriting it from the environment.
 */
export function localHost(): DisposableHost {
  return createLocalHost({ repoRoot: REPO_ROOT, log: () => undefined });
}

/** A named Daytona sandbox, driven through the `daytona` CLI from outside it. */
export function daytonaSandbox(sandboxId: string): DisposableHost {
  const id = sandboxId.trim();
  if (!id) throw new Error("daytonaSandbox(sandboxId) requires a sandbox id.");
  if (runningInsideSandbox()) {
    throw new Error(
      `daytonaSandbox(${JSON.stringify(id)}) cannot be used from inside a sandbox: the daytona CLI indirection has nothing to target. Use localHost() there.`,
    );
  }
  return createDaytonaHost({ sandboxId: id, repoRoot: REPO_ROOT, log: () => undefined });
}
