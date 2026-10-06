import { alphaPublic } from "../alpha/public.ts";
import type { AlphaSecret } from "../alpha/types.ts";
import { alphaInternal } from "../alpha/internal.js";
import { childPublic } from "../alpha/child/public.ts";
import { deltaPublic } from "../delta/public.ts";
export const usesAlpha: [string, string, string, string] = [alphaPublic, alphaInternal, childPublic, deltaPublic];
export type BetaSecret = AlphaSecret;
