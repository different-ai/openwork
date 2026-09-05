/**
 * Docs screenshot pipeline: recomposes the eval app-driver packages
 * (@openwork/hosts, @openwork/behaviors, @openwork/cdp) into declarative
 * scenes that regenerate the images under packages/docs/images.
 *
 * Usage (from the repo root, Node >= 24):
 *   node evals/docs-shots/run.ts --list
 *   node evals/docs-shots/run.ts                 # all scenes
 *   node evals/docs-shots/run.ts library-skills den-skill-editor
 *
 * Requirements: pnpm install at the repo root, MySQL on 127.0.0.1:3306 and
 * Redis on 127.0.0.1:6379 (pnpm dev:den:mysql).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { emulateFocus, freezeMotion, paintBackdrop, setViewport } from "@openwork/cdp";
import { Ctx } from "./ctx.ts";
import { captureUntil } from "./loop.ts";
import { shots } from "./shots/index.ts";
import { DEFAULT_VIEWPORT } from "./shots/shot.ts";
import { REPO_ROOT } from "./surfaces.ts";

// Screenshots must never depend on ambient provider credentials: scenes bring
// their own deterministic model witness where a model is needed at all.
for (const key of [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENWORK_API_KEY",
  "OPENWORK_INFERENCE_BASE_URL",
]) {
  process.env[key] = "";
}

const args = process.argv.slice(2);
if (args.includes("--list")) {
  for (const shot of shots) console.log(`${shot.id}\t${shot.out}`);
  process.exit(0);
}
const requested = args.filter((arg) => !arg.startsWith("--"));
const unknown = requested.filter((id) => !shots.some((shot) => shot.id === id));
if (unknown.length > 0) {
  console.error(`Unknown scene ids: ${unknown.join(", ")}. Use --list.`);
  process.exit(1);
}
const selected = requested.length > 0 ? shots.filter((shot) => requested.includes(shot.id)) : shots;

const ctx = new Ctx();
const failures: string[] = [];
try {
  for (const shot of selected) {
    console.log(`\n[docs-shots] ${shot.id}`);
    try {
      const surface = await shot.run(ctx);
      await setViewport(surface, shot.viewport ?? DEFAULT_VIEWPORT);
      // The capture window is never OS-focused; without focus emulation every
      // shot shows the app's blurred (dimmed) state.
      await emulateFocus(surface);
      // The macOS vibrancy sidebar is a transparent renderer region (the OS
      // composites the tint outside the page, so a raw capture has alpha-0
      // pixels there). Paint the light vibrancy tone at the html level so the
      // capture reads like the real focused window.
      if (surface.handle.kind === "electron") await paintBackdrop(surface, "#232326");
      await freezeMotion(surface);
      const png = await captureUntil(surface, shot.gate);
      const outPath = resolve(REPO_ROOT, shot.out);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, png);
      console.log(`[docs-shots] wrote ${shot.out} (${png.byteLength} bytes)`);
    } catch (error) {
      failures.push(shot.id);
      console.error(`[docs-shots] ${shot.id} FAILED:`, error);
    }
  }
} finally {
  await ctx.dispose();
}
if (failures.length > 0) {
  console.error(`\n[docs-shots] failed scenes: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`\n[docs-shots] all ${selected.length} scene(s) captured.`);
