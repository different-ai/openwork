import { alphaInternal } from "./modules/alpha/internal.ts";
import { modules } from "./modules/registry.ts";
import { FEATURES } from "../../../../packages/features/src/index.ts";
export const core = [alphaInternal, modules, ...FEATURES];
