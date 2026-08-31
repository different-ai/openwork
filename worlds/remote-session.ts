import { fileURLToPath } from "node:url";
import { hold } from "../packages/world/src/hold.ts";
import { launchHeadlessWeb } from "../packages/world/src/headless-web.ts";
import type { HeadlessWebHandle } from "../packages/world/src/headless-web.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REMOTE_SESSION_NAME = "remote-session";
const REMOTE_SESSION_WORKSPACE = "/tmp/openwork-remote-session-world";

export interface RemoteSessionOptions {
  name?: string;
  workspace?: string;
  replace?: boolean;
  keepTokens?: boolean;
  rotateTokens?: boolean;
}

/**
 * Real source-first openwork-server and browser UI used by remote-session
 * gateway capabilities and their real-server spec.
 */
export async function bootRemoteSession(
  stack: AsyncDisposableStack,
  options: RemoteSessionOptions = {},
): Promise<HeadlessWebHandle> {
  const handle = await launchHeadlessWeb({
    repoRoot: REPO_ROOT,
    name: options.name ?? REMOTE_SESSION_NAME,
    state: "isolated",
    workspace: options.workspace ?? REMOTE_SESSION_WORKSPACE,
    replace: options.replace,
    keepTokens: options.keepTokens,
    rotateTokens: options.rotateTokens,
  });
  return stack.adopt(handle, (headless) => headless.stop());
}

export async function main(): Promise<void> {
  await using stack = new AsyncDisposableStack();
  const handle = await bootRemoteSession(stack);
  await hold({
    name: REMOTE_SESSION_NAME,
    outputs: {
      webUrl: handle.manifest.webUrl,
      openworkUrl: handle.manifest.openworkUrl,
      workspace: handle.manifest.workspace,
      runtimeManifest: handle.manifest.runtimeManifestPath,
    },
  });
}

if (import.meta.main) await main();
