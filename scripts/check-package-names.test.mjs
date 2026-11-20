import assert from "node:assert/strict";
import test from "node:test";
import { checkPackageNames, packageNameProblems } from "./check-package-names.mjs";

test("the repository's workspace packages follow the naming rule", () => {
  assert.deepEqual(checkPackageNames(), []);
});

test("a package named differently from its folder is reported", () => {
  assert.deepEqual(packageNameProblems("packages/mcp-apps", "@openwork", "@openwork/mcp-apps"), []);
  assert.match(packageNameProblems("packages/widget-alpha", "@openwork", "@openwork/alpha-widget")[0], /name it @openwork\/widget-alpha/);
  assert.match(packageNameProblems("ee/packages/widget-beta", "@openwork-ee", "@openwork/widget-beta")[0], /name it @openwork-ee\/widget-beta/);
});

test("a folder that repeats openwork is reported, with or without a package.json", () => {
  assert.match(packageNameProblems("packages/openwork-thing", "@openwork", "@openwork/openwork-thing")[0], /repeats "openwork"/);
  assert.match(packageNameProblems("ee/apps/openwork-phone", "@openwork-ee", undefined)[0], /repeats "openwork"/);
  assert.deepEqual(packageNameProblems("ee/apps/mobile-phone", "@openwork-ee", undefined), []);
});

test("an exception must keep the name it is listed with", () => {
  assert.deepEqual(packageNameProblems("apps/server", "@openwork", "openwork-server"), []);
  assert.match(packageNameProblems("apps/server", "@openwork", "@openwork/server")[0], /listed as an exception/);
});
