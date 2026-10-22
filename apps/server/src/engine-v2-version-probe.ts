import { runFile } from "@openwork/child-process";
import { EngineV2StartupTimeoutError } from "./managed-opencode-v2.js";

/** Cold security admission and first engine initialization can exceed a minute. */
export const ENGINE_V2_VERSION_PROBE_TIMEOUT_MS = 180_000;

export async function probeEngineV2Path(
  file = "opencode2",
  timeout = ENGINE_V2_VERSION_PROBE_TIMEOUT_MS,
): Promise<void> {
  try {
    await runFile(file, ["--version"], { timeout });
  } catch (error) {
    if (error instanceof Error && "killed" in error && error.killed === true) {
      throw new EngineV2StartupTimeoutError("OpenCode v2 version probe timed out. Waiting before retrying the installed engine.");
    }
    throw error;
  }
}
