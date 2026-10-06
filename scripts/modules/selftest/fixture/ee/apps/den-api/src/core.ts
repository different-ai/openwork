import { alphaInternal } from "./modules/alpha/internal.ts";
import { kitOneInternal } from "./modules/kit/one/internal.ts";
import { modules } from "./modules/registry.ts";
import { FEATURES } from "../../../../packages/features/src/index.ts";
export const core = [alphaInternal, kitOneInternal, modules, ...FEATURES];
