import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const sourceRoot = join(import.meta.dir, "..", "src");
const sharedModule = "react-app/domains/cloud/use-org-feature.ts";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

function handrolledReads(source: string, allowImperativeRead = false): number[] {
  const file = ts.createSourceFile("source.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = new Set<number>();
  function visit(node: ts.Node) {
    const cacheKey = ts.isStringLiteralLike(node) && node.text === "org-features";
    const directRead = !allowImperativeRead && ts.isCallExpression(node)
      && ((ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "getOrgFeatures")
        || (ts.isElementAccessExpression(node.expression) && ts.isStringLiteralLike(node.expression.argumentExpression)
          && node.expression.argumentExpression.text === "getOrgFeatures"));
    if (cacheKey || directRead) lines.add(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return [...lines];
}

test("organization feature queries belong only in the shared guarded hook", () => {
  const offenders = sourceFiles(sourceRoot).flatMap((path) => {
    const name = relative(sourceRoot, path).split(sep).join("/");
    if (name === sharedModule) return [];
    // These non-React modules implement the HTTP client and imperative sign-in selection, not hooks.
    const imperative = name === "app/lib/den.ts" || name === "app/lib/den-org-memory.ts";
    return handrolledReads(readFileSync(path, "utf8"), imperative).map((line) => `${name}:${line}`);
  });
  expect(offenders, `Use useOrgFeature/useOrgFeatureState from ${sharedModule}; disabled queries still expose cached data`).toEqual([]);
});

test("the guard catches multiline keys and getOrgFeatures under alternate query keys", () => {
  expect(handrolledReads(`useQuery({ queryKey: [\n'den',\n'org-features', orgId] })`)).toEqual([3]);
  expect(handrolledReads(`useQuery({queryKey: ['other-key'], queryFn: () => client.getOrgFeatures(orgId)})`)).toEqual([1]);
  expect(handrolledReads(`useQuery({queryFn: () => client['getOrgFeatures'](orgId)})`)).toEqual([1]);
  expect(handrolledReads(`useOrgFeature('computerUse')`)).toEqual([]);
});
