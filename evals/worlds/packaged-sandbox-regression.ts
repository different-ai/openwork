import { browserScript } from "@openwork/cdp";
import { evalIn } from "@openwork/behaviors";
import type { Place, Seed } from "@openwork/env";
import { packagedBundle } from "./packaged-sandbox-fixtures.ts";
import { sandboxOnlyDesktop } from "./sandbox-only.ts";

/**
 * Deterministic packaged-smoke counterpart of packaged-sandbox-check.ts.
 * Only inference is scripted; Electron, app.asar, the embedded server, plugin,
 * microsandbox and the live absolute-path bind mounts are the shipping artifact.
 * Set the same packaged-smoke binary/prepared-resource variables as the updater gate.
 */
export async function packagedSandboxRegression(seed: Seed, context: { place: Place }) {
  const binary = process.env.OPENWORK_EVAL_ELECTRON_BINARY?.trim();
  if (!binary) throw new Error("Set OPENWORK_EVAL_ELECTRON_BINARY to the branch-built .app executable");
  const artifact = await packagedBundle(binary);
  const world = await sandboxOnlyDesktop(seed, context);
  try {
    const isPackaged = await evalIn(world.app, browserScript(() => {
      const meta: unknown = Reflect.get(window.__OPENWORK_ELECTRON__, "meta");
      return typeof meta === "object" && meta !== null && Reflect.get(meta, "isPackaged") === true;
    }, []));
    if (isPackaged !== true) throw new Error("The packaged regression accidentally launched development Electron");
    return { ...world, artifact, isPackaged };
  } catch (error) { await world[Symbol.asyncDispose](); throw error; }
}
