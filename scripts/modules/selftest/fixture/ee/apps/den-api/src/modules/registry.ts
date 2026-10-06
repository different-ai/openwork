import { alphaModule } from "./alpha/module.ts";
import { alphaChildModule } from "./alpha/child/module.ts";
import { leafModule } from "./alpha/ns/leaf/module.ts";
import { kitOneModule } from "./kit/one/module.ts";
import { kitTwoModule } from "./kit/two/module.ts";
import { betaInternal } from "./beta/internal.ts";
export const modules = [alphaModule, alphaChildModule, leafModule, kitOneModule, kitTwoModule, betaInternal];
