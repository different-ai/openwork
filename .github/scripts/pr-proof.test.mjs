import assert from "node:assert/strict";
import test from "node:test";
import { changedFiles, proofArtifact, safePath, selectProof } from "./pr-proof.mjs";

const file = (filename, status = "modified", previous_filename) => ({ filename, status, ...(previous_filename ? { previous_filename } : {}) });

test("added and changed E2E specs are all selected; removed specs and non-specs are not", () => {
  assert.deepEqual(selectProof([
    file("apps/app/src/a.ts"),
    file("evals/specs/new.e2e.test.ts", "added"),
    file("evals/specs/changed.e2e.test.ts"),
    file("evals/specs/moved.e2e.test.ts", "renamed", "evals/specs/old-name.e2e.test.ts"),
    file("evals/specs/gone.e2e.test.ts", "removed"),
    file("evals/specs/unit.test.ts"),
    file("evals/worlds/chat.ts"),
  ]).specs, ["evals/specs/changed.e2e.test.ts", "evals/specs/moved.e2e.test.ts", "evals/specs/new.e2e.test.ts"]);
});

test("a PR without spec changes selects nothing instead of failing", () => {
  assert.deepEqual(selectProof([file("packages/docs/page.mdx")]).specs, []);
  assert.deepEqual(selectProof([]).specs, []);
});

test("Next.js route groups and dynamic routes preserve proof selection, including renamed paths", () => {
  assert.deepEqual(selectProof([
    file("ee/apps/den-web/app/(den)/install/page.tsx"),
    file("ee/apps/den-web/app/(den)/dashboard/(admin)/plugins/[pluginId]/page.tsx"),
    file("ee/apps/den-web/app/api/auth/[...path]/route.ts"),
    file("ee/apps/diagnostics/app/via/[scenario]/[[...path]]/route.ts", "renamed",
      "ee/apps/diagnostics/app/(old)/[[...path]]/route.ts"),
    file("evals/specs/change.e2e.test.ts", "added"),
  ]).specs, ["evals/specs/change.e2e.test.ts"]);
});

test("unsafe path parts fail closed for both current and previous filenames", () => {
  for (const path of [
    "", ".", "..", "../escape.ts", "apps/./a.ts", "apps/../a.ts", "/absolute.ts",
    "apps//a.ts", "apps/a.ts/", "-apps/a.ts", "apps/-a.ts", "apps\\escape.ts",
    "apps/a file.ts", "apps/a\t.ts", "apps/a\n.ts", "apps/a\0.ts", "apps/a\x7f.ts", "apps/a.ts\n",
    "apps/a;echo.ts", "apps/a&b.ts", "apps/a|b.ts", "apps/$(echo).ts", "apps/`echo`.ts",
    "apps/a'b.ts", 'apps/a"b.ts', "apps/a<b.ts", "apps/a>b.ts", "apps/*.ts", "apps/a?.ts",
    "apps/{a,b}.ts", "apps/!a.ts", "packages/docs/café.mdx", "a".repeat(241),
  ]) {
    assert.equal(safePath(path), false, JSON.stringify(path));
    assert.throws(() => selectProof([file(path)]), /unsafe changed-file listing/);
    assert.throws(() => selectProof([{ filename: "apps/a.ts", status: "renamed", previous_filename: path }]), /unsafe changed-file listing/);
  }
  assert.equal(safePath(null), false);
  assert.equal(safePath("a".repeat(240)), true);
  assert.throws(() => selectProof([file("apps/a.ts"), file("apps/a.ts")]), /Duplicate/);
});

test("changed-file pagination is complete and bounded", async () => {
  const paths = Array.from({ length: 201 }, (_, index) => file(`apps/a-${index}.ts`));
  const calls = [];
  const result = await changedFiles(async path => {
    calls.push(path);
    const page = Number(new URL(`https://example.test/${path}`).searchParams.get("page"));
    return paths.slice((page - 1) * 100, page * 100);
  }, "o/r", 1, paths.length);
  assert.equal(result.length, 201);
  assert.equal(calls.length, 3);
  await assert.rejects(changedFiles(async () => [], "o/r", 1, 3001), /3000-file limit/);
});

test("artifact names are stable, bounded hashes of validated spec paths", () => {
  const name = proofArtifact("evals/specs/change.e2e.test.ts", 2);
  assert.match(name, /^pr-proof-2-[a-f0-9]{64}$/);
  assert.throws(() => proofArtifact("../change.e2e.test.ts", 1));
});
