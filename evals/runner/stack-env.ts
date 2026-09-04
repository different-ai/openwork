import { inject } from "vitest";
import { workerSlot } from "./stack-suite.ts";

const preparation = inject("openworkStackPreparation");

if (preparation.kind === "local") {
  process.env.OPENWORK_EVAL_DEN_RUNTIME_PREPARED = "1";
  process.env.OPENWORK_EVAL_ELECTRON_RESOURCES_PREPARED = "1";
}

if (preparation.kind === "daytona") {
  const slot = preparation.slots[workerSlot(process.env.VITEST_WORKER_ID, preparation.slots.length)];
  if (!slot) throw new Error("Vitest worker did not resolve to a prepared Daytona slot.");
  process.env.OPENWORK_EVAL_DAYTONA_DEN_SANDBOX = slot.denSandbox;
  process.env.OPENWORK_EVAL_DAYTONA_DESKTOP_SANDBOX = slot.desktopSandbox;
}
