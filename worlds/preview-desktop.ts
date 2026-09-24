import { runPreview } from "./lib/preview.ts";
/** Statically read by `pnpm world list`; Windows is withheld until its interactive host is wired. */
export const supportedTargets = ["local/host", "daytona/linux"];
export async function main(): Promise<void> { await runPreview("desktop"); }
if (import.meta.main) await main();
