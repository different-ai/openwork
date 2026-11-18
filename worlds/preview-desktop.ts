import { runPreview } from "./lib/preview.ts";
/**
 * Statically read by `pnpm world list` and `pnpm world help`. Windows requires
 * an exact published blank release; Freestyle runs the signed-out `fresh`
 * desktop from a pushed commit.
 */
export const summary = "The desktop app alone, signed out: no Den, organization, or account (source build or exact published release).";
export const supportedTargets = ["local/host", "daytona/linux", "daytona/windows", "freestyle/linux"];
export async function main(): Promise<void> { await runPreview("desktop"); }
if (import.meta.main) await main();
