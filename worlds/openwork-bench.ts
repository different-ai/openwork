// The preview-desktop app with OpenWork Bench installed in the same sandbox,
// so `owb run <model>@openwork-desktop` drives the app's own server there.
//
//   pnpm world up openwork-bench --place daytona --stage <stage> --detach --timeout 1200000
//   pnpm world up openwork-bench --place daytona --stage <stage> -- --bench-ref <sha> --lifetime 240
//
// The desktop's server address and tokens stay inside the sandbox in an env
// file; outputs name that file and the variables, never their values. No model
// key enters the world: the operator brings a dedicated, capped one per run.
import { resolvePlace } from "../evals/packages/env/src/place.ts";
import { hold } from "../packages/world/src/hold.ts";
import { output } from "../packages/world/src/outputs.ts";
import type { WorldOutput } from "../packages/world/src/outputs.ts";
import { targetFromEnv } from "../packages/world/src/target.ts";
import { daytonaBenchGuest, freestyleBenchGuest, installBench, parseBenchWorldOptions } from "./lib/openwork-bench.ts";
import type { BenchGuest } from "./lib/openwork-bench.ts";
import { bootDesktopPreview, bootFreestyleDesktop, defaultFreestyleDeps, resolveRemoteDev } from "./lib/preview.ts";

/** Statically read by `pnpm world list` and `pnpm world help`. */
export const summary = "The signed-out desktop app with OpenWork Bench installed next to it, ready for owb run <model>@openwork-desktop inside the sandbox.";
export const supportedTargets = ["daytona/linux", "freestyle/linux"];

function outputValue(entry: WorldOutput | undefined): string {
  const value = typeof entry === "string" ? entry : entry?.value;
  if (!value) throw new Error("The desktop preview did not report its sandbox.");
  return value;
}

async function bootDesktop(stack: AsyncDisposableStack, lifetimeMinutes: number): Promise<{ outputs: Record<string, WorldOutput>; guest: BenchGuest }> {
  const target = targetFromEnv();
  if (target.provider === "freestyle") {
    const sha = process.env.OPENWORK_EVAL_REF?.trim() || await resolveRemoteDev();
    const outputs = await bootFreestyleDesktop(stack, { sha, lifetimeMinutes }, await defaultFreestyleDeps());
    return { outputs, guest: await freestyleBenchGuest(outputValue(outputs.freestyleVm)) };
  }
  if (target.provider !== "daytona" || target.os !== "linux") {
    throw new Error("openwork-bench runs on --place daytona or --place freestyle (Linux).");
  }
  process.env.OPENWORK_EVAL_REF ||= await resolveRemoteDev();
  // A preview desktop never auto-stops; this world deletes it when its lifetime ends or on `world down`.
  process.env.OPENWORK_WORLD_PREVIEW_DAYTONA = "1";
  const { desktop, outputs } = await bootDesktopPreview(stack, resolvePlace(), "fresh");
  const cdpPort = Number("handle" in desktop ? desktop.handle.meta?.cdpPort : undefined);
  if (!Number.isInteger(cdpPort) || cdpPort <= 0) throw new Error("The Daytona desktop did not report its CDP port.");
  return { outputs, guest: daytonaBenchGuest(outputValue(outputs.desktopSandbox), cdpPort) };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseBenchWorldOptions(argv);
  await using stack = new AsyncDisposableStack();
  const { outputs, guest } = await bootDesktop(stack, options.lifetimeMinutes);
  Object.assign(outputs, await installBench(guest, options.benchRef));
  const expires = new Date(Date.now() + options.lifetimeMinutes * 60_000);
  outputs.expires ??= output(expires.toISOString(), { group: "World", note: "The sandbox is deleted then; `pnpm world down` deletes it sooner" });
  const timer = setTimeout(() => process.kill(process.pid, "SIGTERM"), options.lifetimeMinutes * 60_000);
  try {
    await hold({ name: "openwork-bench", outputs });
  } finally {
    clearTimeout(timer);
  }
}

if (import.meta.main) await main();
