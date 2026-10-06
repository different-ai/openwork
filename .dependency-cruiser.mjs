// Den module boundaries (W0-08). Rules are generated from the module graph; see
// scripts/modules/rules.mjs. Run `pnpm boundaries:check`.
import graph from "./scripts/modules/module-graph.generated.json" with { type: "json" };
import enforced from "./scripts/modules/enforced-modules.json" with { type: "json" };
import { createDepcruiseConfig } from "./scripts/modules/depcruise-config.mjs";

export default createDepcruiseConfig({
  graph,
  enforced,
  // No dependency-cruiser cache: its content strategy misses newly added files, and a full
  // cruise of the three roots takes a few seconds.
  tsConfig: "tsconfig.depcruise.json",
});
