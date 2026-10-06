import { kitOnePublic } from "../one/public.ts";
import { kitOneInternal } from "../one/internal.ts";
export const kitTwoUsesOne = [kitOnePublic, kitOneInternal];
