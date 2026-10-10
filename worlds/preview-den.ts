import { runPreview } from "./lib/preview.ts";
export const summary = "Den alone (web, API, database), seeded by scenario: no desktop app.";
export const supportedTargets = ["local/host", "daytona/linux"];
export async function main(): Promise<void> { await runPreview("den"); }
if (import.meta.main) await main();
