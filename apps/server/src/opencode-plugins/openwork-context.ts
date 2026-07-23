import { createContextPlugin } from "./lib/context-registry.js";
import { OPENWORK_CONTEXT_REGISTRY } from "./lib/openwork-context-contributors.js";

export const OpenWorkContext = createContextPlugin(OPENWORK_CONTEXT_REGISTRY);
