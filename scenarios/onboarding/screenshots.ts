import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gate } from "../../evals/docs-shots/gate.ts";
import { captureUntil } from "../../evals/docs-shots/loop.ts";
import type { onboardingWorld } from "./world.ts";

/** Capture an already-open scenario using the existing DocShot readiness loop. */
export async function downloadScreenshot(
  world: Awaited<ReturnType<typeof onboardingWorld>>,
) {
  const png = await captureUntil(
    world.web,
    gate({
      expect: ["Download for Linux"],
      never: ["2 invitations sent.", "Give your team a head start."],
    }),
  );
  const directory = join(world.directory, "screenshots");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "download.png"), png);
  return { file: "screenshots/download.png", bytes: png.byteLength };
}
