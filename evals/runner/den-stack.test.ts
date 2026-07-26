import assert from "node:assert/strict";
import test from "node:test";
import { nativeMysqlServerArgs } from "./den-stack.ts";

test("native MariaDB explicitly permits root-owned Daytona runtimes", () => {
  assert(nativeMysqlServerArgs(true).includes("--user=root"));
  assert(!nativeMysqlServerArgs(false).includes("--user=root"));
});
