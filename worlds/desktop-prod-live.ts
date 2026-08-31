import { localHost, resolveInstalledProductionDesktopState } from "../evals/packages/hosts/src/index.ts";
import type { InstalledProductionDesktopState } from "../evals/packages/hosts/src/index.ts";
import { liveSharedProductionApp } from "../evals/packages/env/src/desktop-app.ts";
import type { App } from "../evals/packages/env/src/desktop-app.ts";
import { hold } from "../packages/world/src/hold.ts";

export interface DesktopProductionLiveOptions {
  allowSharedState: true;
  resolveInstalledProductionState?: () => Promise<InstalledProductionDesktopState>;
}

/** Launch source Electron against installed production state after explicit consent. */
export async function desktopProductionLive(options: DesktopProductionLiveOptions): Promise<App> {
  if (options?.allowSharedState !== true) {
    throw new Error("Refusing LIVE SHARED PRODUCTION STATE launch without explicit allowSharedState: true consent.");
  }
  const state = await (
    options.resolveInstalledProductionState ?? resolveInstalledProductionDesktopState
  )();
  return liveSharedProductionApp({
    host: localHost(),
    name: "world-desktop-production-live",
    state,
  });
}

function parseArgs(argv: readonly string[]): DesktopProductionLiveOptions {
  if (argv.length !== 1 || argv[0] !== "--allow-shared-state") {
    throw new Error("Launch desktop-prod-live with exactly --allow-shared-state.");
  }
  return { allowSharedState: true };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  await using desktop = await desktopProductionLive(parseArgs(argv));
  await hold({ outputs: { cdp: desktop.handle.cdpUrl } });
}

if (import.meta.main) {
  await main();
}
