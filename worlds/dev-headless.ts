import { fileURLToPath } from "node:url";
import { hold } from "../packages/world/src/hold.ts";
import { launchHeadlessWeb } from "../packages/world/src/headless-web.ts";
import type { HeadlessWebHandle } from "../packages/world/src/headless-web.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEV_HEADLESS_NAME = "dev-headless";

export interface DevHeadlessOptions {
  name?: string;
  replace?: boolean;
  keepTokens?: boolean;
  rotateTokens?: boolean;
}

function parseArgs(argv: readonly string[]): DevHeadlessOptions {
  const supported = new Set(["--replace", "--keep-tokens", "--rotate-tokens"]);
  const unsupported = argv.find((argument) => !supported.has(argument));
  if (unsupported) throw new Error(`Unsupported dev-headless flag: ${unsupported}`);
  return {
    replace: argv.includes("--replace")
      || ["1", "true", "yes", "on"].includes((process.env.OPENWORK_DEV_HEADLESS_WEB_REPLACE ?? "").trim().toLowerCase()),
    keepTokens: argv.includes("--keep-tokens"),
    rotateTokens: argv.includes("--rotate-tokens"),
  };
}

function outputs(handle: HeadlessWebHandle): Record<string, string> {
  return {
    webUrl: handle.manifest.webUrl,
    openworkUrl: handle.manifest.openworkUrl,
    workspace: handle.manifest.workspace,
    runtimeManifest: handle.manifest.runtimeManifestPath,
  };
}

/** Isolated source UI + local backend. This is the world behind pnpm dev:headless-web. */
export async function bootDevHeadless(
  stack: AsyncDisposableStack,
  options: DevHeadlessOptions = {},
): Promise<HeadlessWebHandle> {
  const handle = await launchHeadlessWeb({
    repoRoot: REPO_ROOT,
    name: options.name ?? DEV_HEADLESS_NAME,
    state: "isolated",
    replace: options.replace,
    keepTokens: options.keepTokens,
    rotateTokens: options.rotateTokens,
  });
  return stack.adopt(handle, (headless) => headless.stop());
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  await using stack = new AsyncDisposableStack();
  const handle = await bootDevHeadless(stack, options);
  await hold({ name: DEV_HEADLESS_NAME, outputs: outputs(handle) });
}

export async function detachDevHeadless(argv: readonly string[]): Promise<void> {
  const options = parseArgs(argv);
  await using stack = new AsyncDisposableStack();
  const handle = await bootDevHeadless(stack, options);
  await handle.detach();
  stack.move();
  for (const [key, value] of Object.entries(outputs(handle))) console.log(`${key}  ${value}`);
  console.log(`World ${JSON.stringify(DEV_HEADLESS_NAME)} is up. Detached; relaunch with --replace to tear it down.`);
}

if (import.meta.main) await main();
