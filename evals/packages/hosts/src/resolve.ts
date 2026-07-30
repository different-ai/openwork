import { fileURLToPath } from "node:url";
import { createDaytonaHost } from "./daytona.ts";
import { createLocalHost } from "./local.ts";
import type { Host } from "./types.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

export async function resolveHost(env: NodeJS.ProcessEnv = process.env): Promise<Host & AsyncDisposable> {
  const sandboxId = env.OPENWORK_EVAL_DAYTONA_SANDBOX?.trim();
  if (sandboxId) {
    return createDaytonaHost({ sandboxId, repoRoot: REPO_ROOT, log: () => undefined });
  }
  return createLocalHost({ repoRoot: REPO_ROOT, log: () => undefined });
}
