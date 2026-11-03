import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { contractInputDigest, contractIsCurrent, invalidateContract, recordContract } from "../den-contract-cache.mjs";

test("build reuse requires unchanged source and complete, unchanged generated outputs", () => {
  const root = mkdtempSync(join(tmpdir(), "openwork-contract-cache-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const write = (name, value) => { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), value); };
  try {
    git("init", "-q");
    write(".gitignore", "/packages/docs/openapi.json\n/packages/sdk/src/gen/\n");
    write("ee/apps/den-api/src/route.ts", "source");
    git("add", ".");
    assert.equal(contractIsCurrent(root), false);
    write("packages/docs/openapi.json", "contract");
    write("packages/sdk/src/gen/types.gen.ts", "types");
    const initial = contractInputDigest(root);
    recordContract(root, initial);
    assert.equal(contractIsCurrent(root), true);
    assert.equal(git("ls-files", "packages/docs/openapi.json", "packages/sdk/src/gen"), "");

    write("packages/sdk/src/gen/types.gen.ts", "edited output");
    assert.equal(contractIsCurrent(root), false);
    write("packages/sdk/src/gen/types.gen.ts", "types");
    assert.equal(contractIsCurrent(root), true);
    rmSync(join(root, "packages/docs/openapi.json"));
    assert.equal(contractIsCurrent(root), false);
    write("packages/docs/openapi.json", "contract");
    assert.equal(contractIsCurrent(root), true);

    write("ee/apps/den-api/src/new-route.ts", "untracked source");
    assert.equal(contractIsCurrent(root), false);
    assert.throws(() => recordContract(root, initial), /inputs changed/);
    rmSync(join(root, "ee/apps/den-api/src/new-route.ts"));
    write("ee/apps/den-api/src/route.ts", "changed source");
    assert.equal(contractIsCurrent(root), false);
    write("ee/apps/den-api/src/route.ts", "source");
    assert.equal(contractIsCurrent(root), true);
    invalidateContract(root);
    assert.equal(contractIsCurrent(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
