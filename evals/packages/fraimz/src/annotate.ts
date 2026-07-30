import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureScreenshot } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "frame";
}

export function fraimz(
  annotate: (msg: string, opts?: unknown) => unknown,
  opts: { outDir?: string } = {},
): (app: Surface, name: string) => Promise<string> {
  const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = opts.outDir ?? join(REPO_ROOT, "evals", "results", "specs", runStamp);
  let sequence = 0;
  return async (app, name) => {
    sequence += 1;
    await mkdir(outDir, { recursive: true });
    const filePath = join(outDir, `${String(sequence).padStart(2, "0")}-${slug(name)}.png`);
    await writeFile(filePath, await captureScreenshot(app.client));
    await annotate(name, filePath);
    return filePath;
  };
}
