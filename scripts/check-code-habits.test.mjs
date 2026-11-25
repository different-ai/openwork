import { test } from "node:test";
import assert from "node:assert/strict";
import { scanSource, checkComments, checkHabits, isAllowedComment, isCommentSource, isSourceFile, makeBaseline, ratchet, addedLinesFromDiff } from "./check-code-habits.mjs";

const file = "apps/app/src/example.tsx";
const scan = (content) => scanSource(file, content);

for (const [name, source] of [
  ["line", "// explanation\nconst value = 1;"],
  ["block", "/* explanation */ const value = 1;"],
  ["JSDoc", "/** explanation */\nfunction value() {}"],
  ["JSX", "const view = <div>{/* explanation */}</div>;"],
]) test(`detects ${name} comments`, () => {
  assert.equal(scan(source).comments.length, 1);
  assert.equal(checkComments(scan(source), new Set([1])).length, 1);
});

for (const [name, source] of [
  ["string and URL", 'const value = "https://example.com//path"; const other = "/* not a comment */";'],
  ["template", "const value = `https://example.com // text ${name} /* text */`;"],
  ["nested template", "const value = `before ${`// nested ${name} /* text */`} // after`;"],
  ["JSX text", 'const view = <div>https://example.com // text /* text */<span title="// text" /></div>;'],
  ["multiline JSX text", "const view = <div>\n // text\n /* more text */\n</div>;"],
  ["regex", "const value = /[//]hello[/*]/g; const other = /https?:\\/\\//;"],
]) test(`ignores comment markers in ${name}`, () => assert.deepEqual(scan(source).comments, []));

test("still detects comments in template expressions and after protected tokens", () => {
  assert.equal(scan('const value = `text ${ /* real */ name }`; // real\nconst view = <div>// text</div>; /* real */').comments.length, 3);
});

for (const directive of [
  "// @ts-expect-error expected type error", "// @ts-ignore", "// @ts-nocheck",
  "// eslint-disable-next-line no-console -- startup", "/* eslint-disable react-hooks/exhaustive-deps */",
  "// eslint-enable", "// biome-ignore lint/suspicious/noExplicitAny: boundary",
  "// prettier-ignore", '/// <reference types="vite/client" />', "/* @vite-ignore */",
  '/* webpackChunkName: "editor" */', "/* webpackMode: 'lazy' */", "/* v8 ignore next */",
  "/* istanbul ignore file */", "// @vitest-environment jsdom", "/** @jsxImportSource react */",
]) test(`allows directive ${directive}`, () => {
  assert.equal(isAllowedComment(directive), true);
  assert.deepEqual(checkComments(scan(directive), new Set([1])), []);
});

test("allows license/copyright headers, not prose that merely mentions directives", () => {
  for (const header of ["/* Copyright 2026 Example */", "/*! MIT License */", "/**\n * SPDX-License-Identifier: MIT\n */"]) {
    assert.deepEqual(checkComments(scan(header), new Set([1, 2, 3])), []);
  }
  assert.equal(isAllowedComment("// use @ts-ignore here"), false);
  assert.equal(isAllowedComment("// licensing behavior", false), false);
  assert.equal(scan("const value = 1;\n// Copyright explanation").comments[0].allowed, false);
});

test("only comments intersecting added lines fail, including block interiors", () => {
  const source = "// existing\nconst value = 1;\n/* existing start\nnew explanation\nexisting end */\n// new";
  assert.deepEqual(checkComments(scan(source), new Set([2])), []);
  assert.deepEqual(checkComments(scan(source), new Set([4, 6])).map((finding) => finding.line), [4, 6]);
});

test("counts only effect calls, including named and namespace aliases", () => {
  const source = 'import ReactAlias, { useEffect as effect } from "react";\nimport * as R from "react";\nuseEffect(() => {});\nuseLayoutEffect(() => {});\nReact.useEffect(() => {});\nReact.useLayoutEffect(() => {});\nReactAlias.useEffect(() => {});\nR.useLayoutEffect(() => {});\neffect(() => {});\nother.useEffect();';
  assert.deepEqual(scan(source).effects, [3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(scan('import { useEffect, useLayoutEffect } from "react"; const text = "useEffect()";').effects, []);
});

test("ratchet passes equal counts and records only positive counts sorted by path", () => {
  const scans = [scan("useEffect(() => {});"), scanSource("apps/app/src/a.ts", "useLayoutEffect(() => {});"), scanSource("apps/app/src/zero.ts", "")];
  const baseline = makeBaseline(scans);
  assert.deepEqual(Object.keys(baseline.effects), ["apps/app/src/a.ts", file]);
  assert.equal(baseline.version, 1);
  assert.deepEqual(ratchet(scans, baseline), []);
});

test("ratchet rejects increases at the file and all calls in a new file", () => {
  const baseline = makeBaseline([scan("useEffect(() => {});")]);
  const findings = ratchet([scan("useEffect(() => {});\nuseLayoutEffect(() => {});")], baseline);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 1);
  assert.match(findings[0].message, /2 effects, baseline 1/);
  assert.deepEqual(ratchet([scan("\nuseEffect(() => {});\nuseLayoutEffect(() => {});")], { version: 1, effects: {} }).map((finding) => finding.line), [2, 3]);
});

test("ratchet requires baseline updates for decreases and deleted files", () => {
  const baseline = makeBaseline([scan("useEffect(() => {});")]);
  for (const scans of [[scan("")], []]) {
    const findings = ratchet(scans, baseline);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /node scripts\/check-code-habits.mjs --update-baseline/);
    assert.equal(findings[0].rule, "no-new-effect");
  }
});

test("parses zero-context diff additions, replacements, deletions and new files", () => {
  const diff = 'diff --git a/apps/app/src/example.tsx b/apps/app/src/example.tsx\n--- a/apps/app/src/example.tsx\n+++ b/apps/app/src/example.tsx\n@@ -1 +1,2 @@\n-old\n+new\n+new\n@@ -9 +10,0 @@\n-old\ndiff --git a/apps/app/src/new.ts b/apps/app/src/new.ts\n--- /dev/null\n+++ b/apps/app/src/new.ts\n@@ -0,0 +1 @@\n+new';
  const added = addedLinesFromDiff(diff);
  assert.deepEqual([...added.get(file)], [1, 2]);
  assert.deepEqual([...added.get("apps/app/src/new.ts")], [1]);
});

test("skips tests, fixtures, stories and generated sources", () => {
  for (const name of ["a.test.ts", "a.spec.tsx", "__tests__/a.ts", "fixtures/a.ts", "__fixtures__/a.ts", "a.stories.tsx", "stories/a.tsx", "generated/a.ts", "a.generated.ts", "a.gen.ts", "a.js"]) {
    assert.equal(isSourceFile(`apps/app/src/${name}`), false, name);
  }
  assert.equal(isSourceFile(file, "// @generated\nconst value = 1;"), false);
  assert.equal(isSourceFile(file, "// Generated by `pnpm features:sync`. Do not edit.\nconst value = 1;"), false);
  assert.equal(isSourceFile(file), true);
  assert.equal(isSourceFile("ee/apps/app/src/example.tsx"), false);
});

test("comment rule covers TypeScript across apps, packages and ee, not declarations or tests", () => {
  for (const name of ["apps/server/src/a.ts", "packages/sdk/src/a.mts", "ee/apps/den-web/app/page.tsx", "ee/packages/den-db/src/a.cts"]) {
    assert.equal(isCommentSource(name), true, name);
  }
  for (const name of ["scripts/a.ts", "evals/a.ts", "packages/sdk/src/a.d.ts", "ee/apps/den-api/test/a.test.ts", "packages/sdk/src/gen/a.ts"]) {
    assert.equal(isCommentSource(name), false, name);
  }
});

test("keeps doc comments on exported package APIs only", () => {
  const source = "/** The contract. */\nexport function value() {}\n/** Internal. */\nfunction other() {}";
  assert.deepEqual(scanSource("packages/sdk/src/a.ts", source).comments.map((comment) => comment.allowed), [true, false]);
  assert.deepEqual(scanSource("ee/packages/den-db/src/a.ts", source).comments.map((comment) => comment.allowed), [true, false]);
  assert.deepEqual(scanSource("apps/server/src/a.ts", source).comments.map((comment) => comment.allowed), [false, false]);
  assert.equal(scanSource("packages/sdk/src/a.ts", "// The contract.\nexport function value() {}").comments[0].allowed, false);
});

test("keeps issue and RFC links, not other links", () => {
  for (const text of ["// Safari drops the header: https://bugs.webkit.org/show_bug.cgi?id=1", "// https://github.com/owner/repo/issues/42", "/* See https://www.rfc-editor.org/rfc/rfc6749#section-4.1 */", "// https://datatracker.ietf.org/doc/html/rfc7636"]) {
    assert.equal(isAllowedComment(text), true, text);
  }
  assert.equal(isAllowedComment("// see https://example.com/docs"), false);
  assert.equal(isAllowedComment("// see https://github.com/owner/repo/blob/main/a.ts"), false);
});

const habitRules = (source, name = file) => checkHabits(scanSource(name, source), new Set(source.split("\n").map((_, index) => index + 1))).map((finding) => finding.rule);

test("flags any, casts, non-null assertions, suppressions and console.log on added lines", () => {
  assert.deepEqual(habitRules("let a: any;"), ["no-new-any"]);
  assert.deepEqual(habitRules("const a = b as string;\nconst c = <string>d;"), ["no-new-cast"]);
  assert.deepEqual(habitRules("const a = b!.c;"), ["no-new-non-null"]);
  assert.deepEqual(habitRules("// @ts-expect-error broken\nconst a = 1;\n/* eslint-disable no-console */\n// biome-ignore lint: x\n// @ts-ignore"), ["no-new-suppression", "no-new-suppression", "no-new-suppression", "no-new-suppression"]);
  assert.deepEqual(habitRules('console.log("x");'), ["no-new-console-log"]);
});

test("allows as const, satisfies, console.error, prettier-ignore and console.log in command-line entry points", () => {
  assert.deepEqual(habitRules('const a = ["x"] as const;\nconst b = { a } satisfies object;\nconsole.error("x");\n// prettier-ignore\nconst c = 1;'), []);
  assert.deepEqual(habitRules('#!/usr/bin/env node\nconsole.log("x");', "packages/world/src/main.ts"), []);
  assert.deepEqual(habitRules('console.log("x");', "packages/world/src/cli.ts"), []);
  assert.deepEqual(habitRules('console.log("x");', "packages/world/src/cli/run.ts"), []);
});

test("habits only fail on added lines", () => {
  const scan = scanSource(file, "let a: any;\nlet b: any;");
  assert.deepEqual(checkHabits(scan, new Set([2])).map((finding) => finding.line), [2]);
});
