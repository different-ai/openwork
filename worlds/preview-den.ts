import { runPreview } from "./lib/preview.ts";
export async function main(): Promise<void> { await runPreview("den"); }
if (import.meta.main) await main();
