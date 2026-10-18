import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Seed } from "@openwork/env";

/** Actual workspace files, engine, OpenWork server and app-web. No model or connector calls. */
async function libraryScale(seed: Seed, count: number) {
  const workspacePath = seed.tmpPath(`library-scale-${count}`);
  await mkdir(workspacePath, { recursive: true });
  for (let start = 0; start < count; start += 50) {
    await Promise.all(Array.from({ length: Math.min(50, count - start) }, async (_, offset) => {
      const index = start + offset;
      const name = `scale-skill-${String(index).padStart(5, "0")}`;
      const folder = join(workspacePath, ".opencode", "skills", name);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: Summarize a project note ${index}.\n---\nRead the note and summarize it.\n`);
    }));
  }
  const app = await seed.appWeb({ name: `library-scale-${count}`, workspacePath, mouse: true, headless: true });
  const workspace = await seed.workspace(app, workspacePath);
  const session = await seed.session(app);
  return { app, workspace, session, count };
}

export const emptyLibraryScale = (seed: Seed) => libraryScale(seed, 0);
export const singleLibraryScale = (seed: Seed) => libraryScale(seed, 1);
export const smallLibraryScale = (seed: Seed) => libraryScale(seed, 20);
export const largeLibraryScale = (seed: Seed) => libraryScale(seed, 10000);
