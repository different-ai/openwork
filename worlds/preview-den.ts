import { runPreview } from "./lib/preview.ts";
/** Den alone (web, API, database): no desktop app. */
export const supportedTargets = ["local/host", "daytona/linux"];
export async function main(): Promise<void> { await runPreview("den"); }
if (import.meta.main) await main();
