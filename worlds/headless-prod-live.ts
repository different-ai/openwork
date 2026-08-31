import { fileURLToPath } from "node:url";
import { hold } from "../packages/world/src/hold.ts";
import { launchHeadlessWeb } from "../packages/world/src/headless-web.ts";
import type { HeadlessWebHandle } from "../packages/world/src/headless-web.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HEADLESS_PROD_LIVE_NAME = "headless-prod-live";

export interface HeadlessProdLiveOptions {
  allowSharedState: true;
}

/** Source web/backend processes using the installed production desktop stores. */
export async function bootHeadlessProdLive(
  stack: AsyncDisposableStack,
  options: HeadlessProdLiveOptions,
): Promise<HeadlessWebHandle> {
  if (options?.allowSharedState !== true) {
    throw new Error("Refusing LIVE SHARED PRODUCTION STATE launch without explicit --allow-shared-state opt-in.");
  }
  const handle = await launchHeadlessWeb({
    repoRoot: REPO_ROOT,
    name: HEADLESS_PROD_LIVE_NAME,
    state: "installed-production",
    allowSharedState: true,
  });
  return stack.adopt(handle, (headless) => headless.stop());
}

function parseArgs(argv: readonly string[]): HeadlessProdLiveOptions {
  if (argv.length !== 1 || argv[0] !== "--allow-shared-state") {
    throw new Error("Launch headless-prod-live with exactly --allow-shared-state.");
  }
  return { allowSharedState: true };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  await using stack = new AsyncDisposableStack();
  const handle = await bootHeadlessProdLive(stack, options);
  await hold({
    name: HEADLESS_PROD_LIVE_NAME,
    outputs: {
      webUrl: handle.manifest.webUrl,
      openworkUrl: handle.manifest.openworkUrl,
      workspace: handle.manifest.workspace,
      runtimeManifest: handle.manifest.runtimeManifestPath,
    },
  });
}

if (import.meta.main) await main();
