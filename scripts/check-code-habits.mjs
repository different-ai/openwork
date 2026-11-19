import ts from "typescript";
import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const baselinePath = path.join(root, "scripts/code-habits-baseline.json");
const scope = "apps/app/src";
const skipped = new Set(["node_modules", "dist", "build", "__tests__", "fixtures", "__fixtures__", "stories", "storybook", "generated", "__generated__", "gen"]);
const commentMessage = "No new comments in app code. Say it with a name, a type or a test; if the code needs explaining, restructure it.";
const effectMessage = "No new useEffect. Fetch with TanStack Query, derive values during render, react to user actions in the event handler, and subscribe to external stores with useSyncExternalStore or the existing Zustand stores.";
const updateMessage = "Effects decreased or the file was removed. Run node scripts/check-code-habits.mjs --update-baseline to tighten the ratchet.";

export function isSourceFile(file, content = "") {
  return file.startsWith(`${scope}/`) && /\.tsx?$/.test(file)
    && !file.split("/").some((part) => skipped.has(part))
    && !/\.(?:test|spec|stories|story|generated|gen)\./.test(file)
    && !/(?:@generated|\bcode generated\b|\bauto-generated\b)/i.test(content.slice(0, 1000));
}

export function isAllowedComment(text, header = false) {
  const body = text.replace(/^\/\/[\/]?|^\/\*+|\*\/$/g, "").replace(/^\s*\*\s?/gm, "").trim();
  return /^(?:@ts-(?:expect-error|ignore|nocheck)\b|eslint-(?:disable\S*|enable\S*)\b|biome-ignore\b|prettier-ignore\b|<reference\b|@vite-ignore\b|webpack[A-Z]\w*\s*:|(?:v8|istanbul) ignore\b|@vitest-environment\b|@jsxImportSource\b)/.test(body)
    || (header && /\b(?:copyright|license|SPDX-License-Identifier)\b/i.test(body));
}

export function scanSource(file, content) {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const protectedRanges = [];
  const effects = [];
  const effectNames = new Set(["useEffect", "useLayoutEffect"]);
  const reactNames = new Set(["React"]);
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) || node.moduleSpecifier.text !== "react") continue;
    if (node.importClause?.name) reactNames.add(node.importClause.name.text);
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) reactNames.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
      if (effectNames.has((binding.propertyName ?? binding.name).text)) effectNames.add(binding.name.text);
    }
  }
  const lineAt = (position) => source.getLineAndCharacterOfPosition(position).line + 1;
  function visit(node) {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
      || node.kind === ts.SyntaxKind.RegularExpressionLiteral || node.kind === ts.SyntaxKind.JsxText) {
      protectedRanges.push([node.getStart(source), node.end]);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if ((ts.isIdentifier(callee) && effectNames.has(callee.text))
        || (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
          && reactNames.has(callee.expression.text) && /^(?:useEffect|useLayoutEffect)$/.test(callee.name.text))) {
        effects.push(lineAt(node.getStart(source)));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  protectedRanges.sort((a, b) => a[0] - b[0]);
  const chunks = [];
  let end = 0;
  for (const [start, stop] of protectedRanges) {
    chunks.push(content.slice(end, start), content.slice(start, stop).replace(/[^\r\n]/g, " "));
    end = stop;
  }
  chunks.push(content.slice(end));
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, chunks.join(""));
  const comments = [];
  let header = true;
  let previousEnd = 0;
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const start = scanner.getTokenPos();
    const stop = scanner.getTextPos();
    header &&= content.slice(previousEnd, start).trim() === "";
    comments.push({ line: lineAt(start), endLine: lineAt(stop - 1), allowed: isAllowedComment(content.slice(start, stop), header) });
    previousEnd = stop;
  }
  return { file, effects, comments };
}

export function checkComments(scan, addedLines) {
  const findings = [];
  for (const comment of scan.comments) {
    if (comment.allowed) continue;
    for (let line = comment.line; line <= comment.endLine; line++) {
      if (!addedLines.has(line)) continue;
      findings.push({ file: scan.file, line, rule: "no-new-comment", message: commentMessage });
      break;
    }
  }
  return findings;
}

export function makeBaseline(scans) {
  return { version: 1, effects: Object.fromEntries(scans.filter((scan) => scan.effects.length > 0)
    .sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0).map((scan) => [scan.file, scan.effects.length])) };
}

export function ratchet(scans, baseline) {
  const findings = [];
  const current = new Map(scans.map((scan) => [scan.file, scan.effects]));
  for (const file of [...new Set([...current.keys(), ...Object.keys(baseline.effects)])].sort()) {
    const effects = current.get(file) ?? [];
    const before = baseline.effects[file] ?? 0;
    if (effects.length > before) {
      const lines = Object.hasOwn(baseline.effects, file) ? [1] : effects;
      for (const line of lines) findings.push({ file, line, rule: "no-new-effect", message: `${effects.length} effects, baseline ${before}. ${effectMessage}` });
    } else if (effects.length < before || (!current.has(file) && Object.hasOwn(baseline.effects, file))) {
      findings.push({ file, line: 1, rule: "no-new-effect", message: `${effects.length} effects, baseline ${before}. ${updateMessage}` });
    }
  }
  return findings;
}

export function addedLinesFromDiff(diff) {
  const added = new Map();
  let file;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) file = undefined;
    if (line.startsWith("+++ ")) {
      const name = line.slice(4);
      file = (name.startsWith('"') ? JSON.parse(name) : name).replace(/^b\//, "");
      if (!added.has(file)) added.set(file, new Set());
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (file && hunk) {
      const start = Number(hunk[1]);
      const count = Number(hunk[2] ?? 1);
      for (let number = start; number < start + count; number++) added.get(file).add(number);
    }
  }
  return added;
}

function git(...args) {
  return execFileSync("git", ["-c", "core.quotepath=false", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
}
async function files(directory) {
  const result = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await files(file));
    else if (isSourceFile(file)) result.push(file);
  }
  return result.sort();
}
export async function main(args = process.argv.slice(2)) {
  if (args.some((arg, index) => arg !== "--update-baseline" && arg !== "--base" && args[index - 1] !== "--base")
    || (args.includes("--base") && (!args[args.indexOf("--base") + 1] || args[args.indexOf("--base") + 1].startsWith("--")))) {
    throw new Error("Usage: node scripts/check-code-habits.mjs [--base <ref>] [--update-baseline]");
  }
  const scans = [];
  for (const file of await files(scope)) {
    const content = await readFile(path.join(root, file), "utf8");
    if (isSourceFile(file, content)) scans.push(scanSource(file, content));
  }
  const total = scans.reduce((sum, scan) => sum + scan.effects.length, 0);
  if (args.includes("--update-baseline")) {
    const baseline = makeBaseline(scans);
    await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`Code habits: recorded ${total} effects in ${Object.keys(baseline.effects).length} files. Review the baseline diff; do not waive new code.`);
    return;
  }
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  const findings = ratchet(scans, baseline);
  let base;
  try {
    base = args.includes("--base")
      ? git("rev-parse", "--verify", "--end-of-options", `${args[args.indexOf("--base") + 1]}^{commit}`).trim()
      : git("merge-base", "HEAD", "origin/dev").trim();
  } catch {
    console.log("Code habits: comment rule skipped; no base commit could be resolved (use --base <ref> or fetch origin/dev).");
  }
  if (base) {
    const added = addedLinesFromDiff(git("diff", "-U0", "--no-renames", base, "--", scope));
    const untracked = new Set(git("ls-files", "--others", "--exclude-standard", "-z", "--", scope).split("\0").filter(Boolean));
    for (const scan of scans) {
      const lines = untracked.has(scan.file)
        ? new Set(scan.comments.flatMap((comment) => Array.from({ length: comment.endLine - comment.line + 1 }, (_, index) => comment.line + index)))
        : added.get(scan.file) ?? new Set();
      findings.push(...checkComments(scan, lines));
    }
  }
  findings.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.rule.localeCompare(b.rule));
  for (const finding of findings) console.error(`${finding.file}:${finding.line} [${finding.rule}] ${finding.message}`);
  console.log(`Code habits: ${findings.length} violation(s); ${total} effects frozen.`);
  if (findings.length) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
