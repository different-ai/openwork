import { alphaTable } from "../../../../../packages/den-db/src/schema/alpha/index.ts";
import { deltaTable } from "../../../../../packages/den-db/src/schema/delta/index.ts";
import { schema } from "../../../../../packages/den-db/src/schema.ts";
export const betaDb = [alphaTable, deltaTable, schema];
