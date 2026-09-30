import { runPreview } from "./lib/preview.ts";
/** Den plus a desktop app wired to it, seeded by scenario (fresh, team, restricted, workspace). */
export const supportedTargets = ["local/host", "daytona/linux"];
export async function main(): Promise<void> { await runPreview("full"); }
if (import.meta.main) await main();
