import assert from "node:assert/strict";
import test from "node:test";
import {
  nativeMysqlServerArgs,
  nativeMysqlSocketArgs,
} from "./den-stack.ts";

test("native MariaDB explicitly permits root-owned Daytona runtimes", () => {
  assert(nativeMysqlServerArgs(true).includes("--user=root"));
  assert(!nativeMysqlServerArgs(false).includes("--user=root"));
});

test("native MariaDB supports fresh and resumed socket authentication", () => {
  assert(!nativeMysqlSocketArgs(false).some((arg) => arg.startsWith("-p")));
  assert(nativeMysqlSocketArgs(true).includes("-ppassword"));
});
