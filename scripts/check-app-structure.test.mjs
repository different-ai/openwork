import { test } from "node:test";
import assert from "node:assert/strict";
import { isImportSource, isLegacyFile, resolveTarget, scanSource, makeBaseline, ratchet } from "./check-app-structure.mjs";

const src = "apps/app/src/";
const feature = `${src}react-app/domains/session/view.tsx`;
const lower = `${src}react-app/design-system/button.tsx`;
const scan = (source, file = lower) => scanSource(file, source);
const rules = (source, file) => scan(source, file).map((finding) => finding.rule);
const empty = { version: 1, imports: [], files: [] };

for (const layer of ["design-system", "kernel", "infra"]) {
  for (const target of ["domains/session/view", "shell/routes"]) {
    test(`${layer} cannot import ${target}`, () => {
      assert.deepEqual(rules(`import x from "@/react-app/${target}"`, `${src}react-app/${layer}/x.ts`), ["lower-layer-feature"]);
    });
  }
}
for (const folder of ["components", "components/ui", "app", "lib", "hooks"]) {
  test(`${folder} cannot import react-app`, () => {
    assert.deepEqual(rules('import type { X } from "@/react-app/kernel/platform"', `${src}${folder}/x.ts`), ["legacy-react-app"]);
  });
}
test("all cross-domain edges are frozen, including hypothetical index imports", () => {
  assert.deepEqual(rules('import x from "../settings/index"', feature), ["cross-domain"]);
  assert.deepEqual(rules('export { X } from "@/react-app/domains/settings/state/x"', feature), ["cross-domain"]);
});
for (const target of ["electron", "electron/renderer", "node:fs", "node:test", "fs", "fs/promises", "path", "child_process", "os", "crypto", "assert/strict", "stream/web"]) {
  test(`renderer cannot import ${target}`, () => {
    assert.deepEqual(rules(`import x from "${target}"`, feature), ["renderer-node"]);
  });
}
test("relative enterprise import cannot cross the renderer boundary", () => {
  assert.deepEqual(rules('import type { X } from "../../../ee/packages/shared/x"', `${src}x.ts`), ["renderer-ee"]);
  assert.equal(scan('import "../../../ee/packages/shared/x"', `${src}x.ts`)[0].target, "ee/packages/shared/x");
});
for (const statement of [
  'import x from "@/react-app/domains/session/x";',
  'import type { X } from "@/react-app/domains/session/x";',
  'import "@/react-app/domains/session/x";',
  'export { X } from "@/react-app/domains/session/x";',
  'export type { X } from "@/react-app/domains/session/x";',
  'export * from "@/react-app/domains/session/x";',
  'const x = import("@/react-app/domains/session/x");',
  'const x = import(`@/react-app/domains/session/x`);',
  'type X = import("@/react-app/domains/session/x").X;',
  'import x = require("@/react-app/domains/session/x");',
  'const x = require("@/react-app/domains/session/x");',
]) test(`parses ${statement}`, () => assert.deepEqual(rules(statement), ["lower-layer-feature"]));

test("alias and relative imports resolve to the same target, with dot segments normalized", () => {
  const target = `${src}react-app/domains/session/x`;
  assert.equal(resolveTarget(lower, "@/react-app/domains/session/x"), target);
  assert.equal(resolveTarget(lower, "../domains/../domains/session/x"), target);
  assert.equal(resolveTarget(lower, "react"), "react");
  assert.deepEqual(scan('import "../domains/session/x"'), scan('import "@/react-app/domains/session/x"'));
});
for (const [name, file, source] of [
  ["same domain", feature, 'import "./chat/x"; import "@/react-app/domains/session/state/x"'],
  ["feature to shared", feature, 'import "@/react-app/design-system/button"; import "@/react-app/kernel/platform"'],
  ["shell to domains", `${src}react-app/shell/root.tsx`, 'import "../domains/session/view"'],
  ["kernel to infra", `${src}react-app/kernel/state.ts`, 'import "../infra/query-client"'],
  ["infra to kernel", `${src}react-app/infra/state.ts`, 'import "../kernel/state"'],
  ["lower to legacy", lower, 'import "@/components/ui/button"; import "@/app/types"'],
  ["unrelated packages", feature, 'import "react"; import "path-to-regexp"; import "crypto-js"'],
  ["comments and strings", lower, '// import "node:fs"\nconst x = \'import "electron"\'; /* export * from "node:os" */'],
  ["similarly named dirs", `${src}react-app/design-system-extra/a.ts`, 'import "@/react-app/shell/root"'],
]) test(`allows ${name}`, () => assert.deepEqual(rules(source, file), []));
for (const file of [
  `${src}a.test.ts`, `${src}a.spec.tsx`, `${src}a.stories.tsx`, `${src}a.story.jsx`,
  `${src}__tests__/a.ts`, `${src}fixtures/a.ts`, `${src}__fixtures__/a.ts`, `${src}stories/a.ts`,
  `${src}storybook/a.ts`, `${src}README.md`, "apps/server/src/a.ts",
]) test(`skips imports in ${file}`, () => {
  assert.equal(isImportSource(file), false);
  assert.deepEqual(scan('import "node:fs"', file), []);
});
for (const extension of ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"]) {
  test(`checks .${extension} source`, () => assert.equal(isImportSource(`${src}a.${extension}`), true));
}
for (const folder of ["components", "app", "lib", "hooks"]) {
  test(`new ${folder} source fails placement`, () => {
    const file = `${src}${folder}/nested/new.tsx`;
    const failures = ratchet([], [file], empty);
    assert.equal(isLegacyFile(file), true);
    assert.equal(failures[0].rule, "legacy-file");
    assert.match(failures[0].message, /react-app\/domains\/<feature>\//);
  });
}
test("placement permits UI primitives and new architecture, but freezes legacy tests and styles too", () => {
  const files = [`${src}components/ui/new.tsx`, feature, lower, `${src}i18n/new.ts`, `${src}styles/new.css`];
  assert.deepEqual(ratchet([], files, empty), []);
  assert.equal(isLegacyFile(`${src}app/index.css`), true);
  assert.equal(isLegacyFile(`${src}lib/a.test.ts`), true);
  assert.equal(isLegacyFile(`${src}app/data/prompt.md`), false);
});
test("baseline aggregates duplicate edges, sorts stably and has no line numbers", () => {
  const findings = scan('import "node:fs"; import "node:fs"; import "node:path"');
  const files = [`${src}lib/z.ts`, `${src}app/a.ts`, `${src}lib/z.ts`, lower];
  const baseline = makeBaseline(findings, files);
  assert.deepEqual(baseline, makeBaseline([...findings].reverse(), [...files].reverse()));
  assert.equal(baseline.imports[0].count, 2);
  assert.equal("line" in baseline.imports[0], false);
  assert.deepEqual(baseline.files, [`${src}app/a.ts`, `${src}lib/z.ts`]);
});
test("existing imports and files pass even after line movement", () => {
  const source = 'import "node:fs";';
  const files = [`${src}lib/existing.ts`];
  const baseline = makeBaseline(scan(source), files);
  assert.deepEqual(ratchet(scan(`\n\n${source}`), files, baseline), []);
});
test("new edges, duplicates and files cannot borrow frozen allowances", () => {
  const source = 'import "node:fs";';
  const baseline = makeBaseline(scan(source), []);
  assert.equal(ratchet(scan(source + source), [], baseline).length, 1);
  assert.equal(ratchet([...scan(source), ...scan(source, feature)], [], baseline)[0].rule, "renderer-node");
  assert.equal(ratchet([...scan(source), ...scan('import "node:path";')], [], baseline)[0].rule, "renderer-node");
});
test("removing a frozen edge, lowering its count or moving it requires baseline cleanup", () => {
  const source = 'import "node:fs";';
  const baseline = makeBaseline(scan(source + source), []);
  for (const findings of [[], scan(source)]) {
    const failures = ratchet(findings, [], baseline);
    assert.equal(failures[0].rule, "stale-baseline");
    assert.match(failures[0].message, /node scripts\/check-app-structure\.mjs --update-baseline/);
  }
  assert.equal(ratchet(scan(source + source, feature), [], baseline).at(-1).rule, "stale-baseline");
});
test("deleting or moving legacy files is allowed after tightening the baseline", () => {
  const files = [`${src}lib/existing.ts`];
  const baseline = makeBaseline([], files);
  assert.equal(ratchet([], [feature], baseline)[0].rule, "stale-baseline");
  assert.deepEqual(ratchet([], [feature], makeBaseline([], [feature])), []);
});
test("findings use the real import line and actionable diagnostics", () => {
  const failures = ratchet(scan('\n\nimport "node:fs"'), [], empty);
  assert.equal(failures[0].line, 3);
  assert.match(failures[0].message, /desktop IPC bridge or a server API/);
});
