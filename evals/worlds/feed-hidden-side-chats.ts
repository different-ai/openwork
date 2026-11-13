import type { Seed } from "@openwork/env";
import { cmdkSessionActionParity } from "./cmdk-session-action-parity.ts";

/** Reuse real local-first v2 conversations with a deterministic configured provider. */
export async function feedHiddenSideChats(seed: Seed) {
  const world = await cmdkSessionActionParity(seed);
  // The provider enables task creation, but this proof never sends a prompt.
  // Native creation times put the side discussion between the two main tasks.
  return { app: world.app, workspace: world.workspace, above: world.main, side: world.side, below: world.untouched };
}
