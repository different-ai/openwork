import { alphaInternal } from "./internal.js";
import { childInternal } from "./child/internal.ts";
import { leafInternal } from "./ns/leaf/internal.ts";
export const alphaService = [alphaInternal, childInternal, leafInternal];
