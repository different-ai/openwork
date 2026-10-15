export const summary = "Your working tree as the local server plus web app, keeping its state between runs. Add --browser for a headless Chrome you can drive over CDP.";
export const supportedTargets = ["local/host"];

import { fileURLToPath } from "node:url";
import { chrome } from "../evals/packages/hosts/src/browser.ts";
import { localHost } from "../evals/packages/hosts/src/resolve.ts";
import { hold } from "../packages/world/src/hold.ts";
import { launchHeadlessWeb } from "../packages/world/src/headless-web.ts";
import type { HeadlessWebHandle } from "../packages/world/src/headless-web.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORLD_NAME = "dev-app-web";
// Runtime state name: keeps existing tmp/dev-headless-web.json state and tokens.
const DEV_HEADLESS_NAME = "dev-headless";

export interface DevHeadlessOptions {
  name?: string;
  replace?: boolean;
  keepTokens?: boolean;
  rotateTokens?: boolean;
  /** Also open the app in headless Chrome and report its CDP address. Nothing opens on screen. */
  browser?: boolean;
}

function parseArgs(argv: readonly string[]): DevHeadlessOptions {
  const supported = new Set(["--replace", "--keep-tokens", "--rotate-tokens", "--browser"]);
  const unsupported = argv.find((argument) => !supported.has(argument));
  if (unsupported) throw new Error(`Unsupported dev-app-web flag: ${unsupported}`);
  return {
    replace: argv.includes("--replace")
      || ["1", "true", "yes", "on"].includes((process.env.OPENWORK_DEV_HEADLESS_WEB_REPLACE ?? "").trim().toLowerCase()),
    keepTokens: argv.includes("--keep-tokens"),
    rotateTokens: argv.includes("--rotate-tokens"),
    browser: argv.includes("--browser"),
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
  assertDevHeadlessPlacement(process.env);
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

/**
 * The app open in headless Chrome, for hands-on checks over its CDP address.
 * The page reports focus the way a person's window does.
 */
export async function openDevHeadlessBrowser(stack: AsyncDisposableStack, webUrl: string): Promise<string> {
  const host = stack.use(localHost());
  const browser = stack.use(await chrome({ name: WORLD_NAME, host, startUrl: webUrl, headless: true }));
  await browser.client.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  return browser.handle.cdpUrl;
}

export function assertDevHeadlessPlacement(env: NodeJS.ProcessEnv): void {
  if (env.OPENWORK_WORLD_PLACE && env.OPENWORK_WORLD_PLACE !== "local") {
    throw new Error("dev-app-web supports only --place local; use preview-app-web for Daytona.");
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  await using stack = new AsyncDisposableStack();
  const handle = await bootDevHeadless(stack, options);
  const cdp = options.browser ? await openDevHeadlessBrowser(stack, handle.manifest.webUrl) : undefined;
  await hold({ name: WORLD_NAME, outputs: { ...outputs(handle), ...(cdp ? { cdp } : {}) } });
}

export async function detachDevHeadless(argv: readonly string[]): Promise<void> {
  const options = parseArgs(argv);
  if (options.browser) throw new Error("--browser needs a held world: run `pnpm world up dev-app-web --detach -- --browser`.");
  await using stack = new AsyncDisposableStack();
  const handle = await bootDevHeadless(stack, options);
  await handle.detach();
  stack.move();
  for (const [key, value] of Object.entries(outputs(handle))) console.log(`${key}  ${value}`);
  console.log(`World ${JSON.stringify(WORLD_NAME)} is up. Detached; relaunch with --replace to tear it down.`);
}

if (import.meta.main) await main();
