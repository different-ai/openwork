import { runPreview } from "./lib/preview.ts";
export const summary = "Den plus a desktop app wired to it, seeded by scenario; use --seed workspace for a signed-in desktop.";
export const supportedTargets = ["local/host", "daytona/linux"];
export async function main(): Promise<void> { await runPreview("full"); }
if (import.meta.main) await main();
