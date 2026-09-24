import { runPreview } from "./lib/preview.ts";
/** Statically read by `pnpm world list`; Windows requires an exact published blank release. */
export const supportedTargets = ["local/host", "daytona/linux", "daytona/windows"];
export async function main(): Promise<void> { await runPreview("desktop"); }
if (import.meta.main) await main();
