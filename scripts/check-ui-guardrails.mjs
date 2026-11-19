import ts from "typescript";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const baselinePath = path.join(root, "scripts/ui-guardrails-baseline.json");
export const scanRoots = ["apps/app/src", "ee/apps/den-web", "ee/packages/workbot-ui"];
const skipped = new Set(["node_modules", ".next", "dist", "build", "__tests__", "fixtures", "storybook"]);
const messages = {
  "raw-control": "Use the shared Switch/Checkbox or Select (DESIGN.md P5).",
  "unportaled-popup": "Use a portaled Base UI/shared popup, not an absolute menu/listbox (P5).",
  "faint-text": "Use readable semantic body/label ink, not faint neutral/opacity tokens (V1, V2).",
  "tiny-text": "Use the shared type scale, not 10px or smaller text (V1).",
};

function textLiteral(node) {
  return ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
}
function literals(node) {
  if (!node) return "";
  const values = [];
  function visit(child) {
    if (textLiteral(child)) values.push(child.text);
    ts.forEachChild(child, visit);
  }
  visit(node);
  return values.join(" ");
}
function attribute(node, name) {
  return node.attributes.properties.find((prop) => ts.isJsxAttribute(prop) && prop.name.getText() === name)?.initializer;
}
function isPortal(node) {
  return (ts.isJsxElement(node) && /(?:^|\.)(?:Portal|SelectPortal|DropdownMenuPortal|PopoverPortal|DialogPortal|SelectContent|DropdownMenuContent|PopoverContent)$/.test(node.openingElement.tagName.getText()))
    || (ts.isCallExpression(node) && /(?:^|\.)createPortal$/.test(node.expression.getText()));
}
function absolute(node) {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  if (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) return false;
  return /(?:^|[\s:])!?absolute!?(?:\s|$)/.test(literals(attribute(opening, "className")))
    || /position\s*:\s*["']absolute["']/.test(attribute(opening, "style")?.getText() ?? "");
}

/** Syntax-only policy: literal utilities/attributes, including conditional class expressions. No CSS inference. */
export function scanSource(file, content) {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings = [];
  const add = (rule, node, witness = node.getText(source)) => {
    const fingerprint = createHash("sha256").update(witness.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
    findings.push({ file, rule, fingerprint, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
  };
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      if (tag === "select" || (tag === "input" && literals(attribute(node, "type")) === "checkbox")) add("raw-control", node);
      if (/^(menu|listbox)$/.test(literals(attribute(node, "role")))) {
        let positioned = absolute(node);
        let portaled = false;
        for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
          if (isPortal(ancestor)) { portaled = true; break; }
          // Stop at the component boundary, not unrelated JSX elsewhere in the file.
          if (ts.isArrowFunction(ancestor) || ts.isFunctionDeclaration(ancestor)) break;
          positioned ||= absolute(ancestor);
        }
        if (positioned && !portaled) add("unportaled-popup", node);
      }
    }
    if (textLiteral(node)) {
      // Icon ink isn't body/label text. All other literal utilities (including shared class constants)
      // are checked conservatively; dynamic CSS and computed class names require design review.
      let icon = false;
      for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
        if (ts.isJsxOpeningElement(ancestor) || ts.isJsxSelfClosingElement(ancestor)) {
          icon = /^(svg|path|circle)$|Icon$/.test(ancestor.tagName.getText(source));
          break;
        }
      }
      for (const token of node.text.split(/\s+/)) {
        if (!icon && /(?:^|:)text-(?:(?:gray|slate|zinc|neutral|stone)-(?:50|[1-4]00)(?:\/\d+)?|(?:foreground|muted-foreground)\/(?:[1-4]?\d|50))$/.test(token)) add("faint-text", node, token);
        const size = token.match(/(?:^|:)text-\[(\d+(?:\.\d+)?)(px|rem)\]$/);
        if (size && Number(size[1]) * (size[2] === "rem" ? 16 : 1) <= 10) add("tiny-text", node, token);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return findings;
}

export function ratchet(findings, baseline) {
  const remaining = new Map(baseline.map(({ file, rule, fingerprint, count }) => [`${file}:${rule}:${fingerprint}`, count]));
  return findings.filter((finding) => {
    const key = `${finding.file}:${finding.rule}:${finding.fingerprint}`;
    const count = remaining.get(key) ?? 0;
    if (count === 0) return true;
    remaining.set(key, count - 1);
    return false;
  });
}
export function makeBaseline(findings) {
  const entries = new Map();
  for (const { file, rule, fingerprint } of findings) {
    const key = `${file}:${rule}:${fingerprint}`;
    const entry = entries.get(key) ?? { file, rule, fingerprint, count: 0 };
    entry.count++;
    entries.set(key, entry);
  }
  return [...entries.values()].sort((a, b) => `${a.file}:${a.rule}:${a.fingerprint}`.localeCompare(`${b.file}:${b.rule}:${b.fingerprint}`));
}
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(full));
    else if (/\.[jt]sx?$/.test(entry.name) && !/\.(test|spec|stories)\./.test(entry.name)) result.push(full);
  }
  return result.sort();
}
async function main() {
  const findings = [];
  for (const directory of scanRoots) for (const file of await files(path.join(root, directory))) {
    findings.push(...scanSource(path.relative(root, file).split(path.sep).join("/"), await readFile(file, "utf8")));
  }
  if (process.argv.includes("--update-baseline")) {
    await writeFile(baselinePath, `${JSON.stringify({ version: 1, entries: makeBaseline(findings) }, null, 2)}\n`);
    console.log(`Recorded ${findings.length} existing UI violations. Review the baseline diff; do not waive new code.`);
    return;
  }
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  const added = ratchet(findings, baseline.entries);
  for (const finding of added) console.error(`${finding.file}:${finding.line} [${finding.rule}] ${messages[finding.rule]}`);
  console.log(`UI guardrails: ${added.length} new violation(s); ${findings.length - added.length} baseline occurrence(s).`);
  if (added.length) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
