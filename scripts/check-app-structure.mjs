import ts from "typescript";
import { builtinModules } from "node:module";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const baselinePath = path.join(root, "scripts/app-structure-baseline.json");
const sourceRoot = "apps/app/src/";
const reactRoot = `${sourceRoot}react-app/`;
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const codeExtension = /\.[cm]?[jt]sx?$/;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const key = ({ file, rule, target }) => JSON.stringify([file, rule, target]);
const messages = {
  "lower-layer-feature": "Lower layers (design-system, kernel, infra) cannot depend on a feature or shell. Move the shared piece into design-system, kernel or infra, or pass it in as a prop/callback.",
  "legacy-react-app": "Legacy components/, app/, lib/ and hooks/ cannot depend on react-app/. Move the consumer into react-app/domains/<feature>/, or move the shared contract down and pass UI behavior in.",
  "cross-domain": "Domains have no public entry points. Keep new dependencies inside the feature; move shared contracts into kernel/infra or compose the features in shell/ instead of adding a cross-domain import.",
  "renderer-node": "Renderer code cannot import Electron or Node built-ins. Use the desktop IPC bridge or a server API; keep Node implementation code outside apps/app/src/.",
  "renderer-ee": "Renderer code cannot reach into ee/ by relative path. Use a shared package contract or the server API instead.",
  "legacy-file": "New files go in apps/app/src/react-app/domains/<feature>/ (or react-app/design-system for shared UI); components/, app/, lib/ and hooks/ are closed to new files (except components/ui/).",
};

export function isImportSource(file) {
  return file.startsWith(sourceRoot) && codeExtension.test(file)
    && !/(?:^|\/)(?:__tests__|__fixtures__|fixtures|stories|storybook)(?:\/|$)/.test(file)
    && !/\.(?:test|spec|stories|story)\.[cm]?[jt]sx?$/.test(file);
}
export function isLegacyFile(file) {
  const local = file.startsWith(sourceRoot) ? file.slice(sourceRoot.length) : "";
  return /^(?:components|app|lib|hooks)\//.test(local) && !local.startsWith("components/ui/")
    && /\.(?:[cm]?[jt]sx?|css|scss|sass|less)$/.test(file);
}
export function resolveTarget(file, specifier) {
  if (specifier.startsWith("@/")) return path.posix.normalize(`${sourceRoot}${specifier.slice(2)}`);
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  }
  return specifier;
}
export function scanSource(file, content) {
  if (!isImportSource(file)) return [];
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const findings = [];
  const local = file.slice(sourceRoot.length);
  const domain = file.match(/\/react-app\/domains\/([^/]+)\//)?.[1];
  function check(node) {
    if (!node || !ts.isStringLiteralLike(node)) return;
    const specifier = node.text;
    const target = resolveTarget(file, specifier);
    const targetDomain = target.match(/^apps\/app\/src\/react-app\/domains\/([^/]+)(?:\/|$)/)?.[1];
    const add = (rule) => findings.push({ file, rule, target, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    if (/^react-app\/(?:design-system|kernel|infra)\//.test(local)
      && target.startsWith(reactRoot) && /^(?:domains|shell)(?:\/|$)/.test(target.slice(reactRoot.length))) add("lower-layer-feature");
    if (/^(?:components|app|lib|hooks)\//.test(local) && target.startsWith(reactRoot)) add("legacy-react-app");
    if (domain && targetDomain && domain !== targetDomain) add("cross-domain");
    if (specifier === "electron" || specifier.startsWith("electron/") || specifier.startsWith("node:") || builtins.has(specifier)) add("renderer-node");
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && target.startsWith("ee/")) add("renderer-ee");
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) check(node.moduleSpecifier);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) check(node.argument.literal);
    else if (ts.isExternalModuleReference(node)) check(node.expression);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) check(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return findings;
}
export function makeBaseline(findings, files) {
  const entries = new Map();
  for (const { file, rule, target } of findings) {
    const id = key({ file, rule, target });
    const entry = entries.get(id) ?? { file, rule, target, count: 0 };
    entry.count++;
    entries.set(id, entry);
  }
  return {
    version: 1,
    imports: [...entries.values()].sort((a, b) => compare(key(a), key(b))),
    files: [...new Set(files.filter(isLegacyFile))].sort(compare),
  };
}
export function ratchet(findings, files, baseline) {
  const remaining = new Map(baseline.imports.map((entry) => [key(entry), entry.count]));
  const failures = [];
  for (const finding of findings) {
    const id = key(finding);
    const count = remaining.get(id) ?? 0;
    if (count > 0) remaining.set(id, count - 1);
    else failures.push({ ...finding, message: `${messages[finding.rule]} Imported target: ${finding.target}.` });
  }
  const refresh = "Run node scripts/check-app-structure.mjs --update-baseline to remove stale entries; review the diff and do not waive new code.";
  for (const entry of baseline.imports) {
    const count = remaining.get(key(entry)) ?? 0;
    if (count) failures.push({ file: entry.file, line: 1, rule: "stale-baseline", message: `${count} frozen ${entry.rule} import(s) of ${entry.target} no longer exist. ${refresh}` });
  }
  const legacy = new Set(files.filter(isLegacyFile));
  const frozen = new Set(baseline.files);
  for (const file of [...legacy].sort(compare)) {
    if (!frozen.has(file)) failures.push({ file, line: 1, rule: "legacy-file", message: messages["legacy-file"] });
  }
  for (const file of baseline.files) {
    if (!legacy.has(file)) failures.push({ file, line: 1, rule: "stale-baseline", message: `Frozen legacy file no longer exists. ${refresh}` });
  }
  return failures;
}
async function files(directory) {
  const result = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    if (["node_modules", "dist", "build", ".git"].includes(entry.name)) continue;
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await files(file));
    else if (entry.isFile()) result.push(file);
  }
  return result.sort(compare);
}
async function main() {
  const allFiles = await files(sourceRoot.slice(0, -1));
  const findings = [];
  for (const file of allFiles.filter(isImportSource)) findings.push(...scanSource(file, await readFile(path.join(root, file), "utf8")));
  if (process.argv.includes("--update-baseline")) {
    const baseline = makeBaseline(findings, allFiles);
    await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`App structure: recorded ${findings.length} existing import violation(s) and ${baseline.files.length} legacy file(s). Review the baseline diff; do not waive new code.`);
    return;
  }
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  if (baseline.version !== 1) throw new Error("Unsupported app structure baseline version; run node scripts/check-app-structure.mjs --update-baseline.");
  const failures = ratchet(findings, allFiles, baseline);
  for (const finding of failures) console.error(`${finding.file}:${finding.line} [${finding.rule}] ${finding.message}`);
  console.log(`App structure: ${failures.length} failure(s); ${findings.length} import occurrence(s); ${baseline.files.length} legacy file(s).`);
  if (failures.length) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
