// dependency-cruiser config for the boundary self-test (scripts/modules/selftest/run.mjs).
// BOUNDARY_SELFTEST_MODE=enforced turns every module and Core rule to "error".
import graph from "./fixture-graph.json" with { type: "json" };
import { fileURLToPath } from "node:url";
import { createDepcruiseConfig } from "../depcruise-config.mjs";

const enforcedMode = process.env.BOUNDARY_SELFTEST_MODE === "enforced";

export default createDepcruiseConfig({
  graph,
  enforced: { core: enforcedMode, modules: enforcedMode ? graph.modules.map((module) => module.id) : [] },
  prefix: "scripts/modules/selftest/fixture/",
  // Absolute: TypeScript resolves `include` wrongly for a relative config path outside the cwd.
  tsConfig: fileURLToPath(new URL("./tsconfig.json", import.meta.url)),
});
