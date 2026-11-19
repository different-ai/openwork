// Three rules for e2e tests, no baseline. Every message says what to do instead.
//
//   allowed-files  evals/core holds only the journeys in evals/journeys.ts;
//                  evals/proofs holds one-off <name>.proof.test.ts proofs;
//                  evals/specs is retired.
//   real-product   drive the built product the way a user or client does: no
//                  product-source imports, mocks, filesystem/process/database
//                  access, or reaching into the app (evalIn, localStorage...).
//   honest         no skips, sleeps or self-graded evidence, and every test
//                  asserts something a person or client observes.
import ts from "typescript";
import { journeys } from "../../journeys.ts";

export type Rule = "allowed-files" | "real-product" | "honest";
export const rules: readonly Rule[] = ["allowed-files", "real-product", "honest"];

export interface Violation {
  rule: Rule;
  file: string;
  line: number;
  message: string;
}

const ALLOWED_PACKAGES = new Set(["@openwork/testkit", "@openwork/behaviors", "@openwork/matchers", "vitest", "zod"]);
// Public contract packages: the schemas and SDK a real client of the product uses.
const PUBLIC_CONTRACT = /^@openwork\/(types|sdk)(\/|$)/;
const BANNED_NODE_MODULES = new Set(["fs", "fs/promises", "child_process", "net"]);
const MOCK_CALLS = new Set(["vi.mock", "vi.doMock", "vi.fn", "vi.spyOn", "vi.stubGlobal", "vi.stubEnv", "vi.useFakeTimers"]);
const SKIP_METHODS = new Set(["skip", "skipIf", "runIf", "only", "todo"]);
const SLEEP_CALLS = new Set(["setTimeout", "setInterval", "sleep", "delay", "waitForTimeout"]);
const BACKDOOR_CALLS = new Set(["evalIn", "denFetch", "executeJavaScript", "addInitScript", "queryDenDatabase"]);
const BACKDOOR_METHODS = new Set(["evaluate", "evalIn", "eval", "storage"]);
const OBSERVE_METHODS = new Set(["see", "notSee", "looks", "eventually"]);
const OBSERVE_IMPORT = /^(expect|assert|see|verify)/;

const JOURNEY_LIST = Object.entries(journeys).map(([name, purpose]) => `${name} (${purpose})`).join("; ");

const MESSAGES = {
  unlisted: (file: string) =>
    `${file} is not a core journey. Prove your change with a one-off evals/proofs/<name>.proof.test.ts, or add a step to one of the journeys: ${JOURNEY_LIST}`,
  specs: () =>
    `evals/specs is retired. Prove your change with evals/proofs/<name>.proof.test.ts, or add a step to a core journey in evals/core.`,
  suffix: (file: string) =>
    `${file}: only *.e2e.test.ts journeys (evals/core) and *.proof.test.ts proofs (evals/proofs) belong here. Unit and integration tests live next to the module they test (apps/*/test, ee/apps/*/test, packages/*/src/*.test.ts).`,
  sourceImport: (specifier: string) =>
    `Imports "${specifier}". Drive the built product; if you need a capability, add a user.* or api.* behavior to @openwork/behaviors.`,
  mock: (call: string) => `${call}: mocks prove nothing end to end. Use a world option or a fault server (see the fake-model-faults skill).`,
  node: (what: string) => `${what}: observe the result the way a user or client would (UI, public API, MCP). Setup belongs in the world.`,
  backdoor: (what: string) => `${what}: reaches around the product. Use what a person sees (user.see, probe.dom) or a public-API behavior.`,
  skip: (call: string) => `${call}: a skip must be reported, not hidden. Declare requirements with spec.world(world, { needs }).`,
  sleep: (call: string) => `${call}: wait for an observable state with probe.eventually or user.see({ ... }, { timeoutMs }).`,
  selfGraded: () => `recordAssertionEvidence(..., true) grades itself. Assert with expect or user.see instead.`,
  unobserved: (title: string) => `"${title}" never asserts what a person or client observes (user.see/notSee, expect on a response, probe.eventually).`,
};

function calleeText(node: ts.Expression, source: ts.SourceFile): string {
  return node.getText(source).replace(/\s+/g, "");
}

function lastName(text: string): string {
  const parts = text.split(".");
  return parts[parts.length - 1] ?? text;
}

function titleText(node: ts.Node, source: ts.SourceFile): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.getText(source).slice(1, -1);
  return node.getText(source);
}

function isSourceImport(specifier: string): boolean {
  if (specifier.startsWith("@/") || specifier.startsWith("/")) return true;
  if (/^(\.\.\/){2,}(apps|ee|packages|\.github)\//.test(specifier)) return true;
  if (/^(\.\.\/)?packages\/[^/]+\/src(\/|$)/.test(specifier)) return true;
  if (specifier.startsWith("@openwork/") && !ALLOWED_PACKAGES.has(specifier) && !PUBLIC_CONTRACT.test(specifier)) return true;
  return false;
}

export function lintSource(file: string, text: string): Violation[] {
  const violations: Violation[] = [];
  const add = (rule: Rule, line: number, message: string) => violations.push({ rule, file, line, message });

  if (file.startsWith("specs/")) {
    add("allowed-files", 1, MESSAGES.specs());
    return violations;
  }
  if (file.startsWith("core/")) {
    const name = /^core\/([^/]+)\.e2e\.test\.ts$/.exec(file)?.[1];
    if (!name) {
      add("allowed-files", 1, MESSAGES.suffix(file));
      return violations;
    }
    if (!Object.hasOwn(journeys, name)) add("allowed-files", 1, MESSAGES.unlisted(file));
  } else if (file.startsWith("proofs/")) {
    if (!/^proofs\/[^/]+\.proof\.test\.ts$/.test(file)) {
      add("allowed-files", 1, MESSAGES.suffix(file));
      return violations;
    }
  } else {
    return violations;
  }

  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const testBindings = new Set<string>();
  const observingImports = new Set<string>();
  const localFunctions = new Map<string, ts.Node>();

  const checkSpecifier = (specifier: string, node: ts.Node, typeOnly: boolean) => {
    const name = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
    if (BANNED_NODE_MODULES.has(name) || /mysql/.test(specifier)) {
      add("real-product", lineOf(node), MESSAGES.node(`import "${specifier}"`));
      return;
    }
    // Type-only imports are erased; they cannot reach around the product.
    if (typeOnly && specifier.startsWith("@openwork/")) return;
    if (isSourceImport(specifier)) add("real-product", lineOf(node), MESSAGES.sourceImport(specifier));
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      checkSpecifier(specifier, statement, statement.importClause?.isTypeOnly === true);
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if ((specifier === "@openwork/testkit" || specifier === "vitest") && (imported === "test" || imported === "it")) testBindings.add(element.name.text);
          if (OBSERVE_IMPORT.test(imported) && specifier.startsWith("@openwork/")) observingImports.add(element.name.text);
        }
      }
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      checkSpecifier(statement.moduleSpecifier.text, statement, statement.isTypeOnly);
    }
  }

  const collect = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) localFunctions.set(node.name.text, node.body);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = node.initializer;
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) localFunctions.set(node.name.text, initializer.body);
      if (ts.isCallExpression(initializer)) {
        const callee = calleeText(initializer.expression, source);
        if (/^spec\.\w+$/.test(callee) || /\.extend$/.test(callee) || testBindings.has(callee.split(".")[0] ?? "")) testBindings.add(node.name.text);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const tests: { title: string; node: ts.CallExpression; body: ts.Node | undefined }[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = calleeText(node.expression, source);
      const name = lastName(callee);
      const first = node.arguments[0];
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && first && ts.isStringLiteral(first)) checkSpecifier(first.text, node, false);
      if (callee === "require" && first && ts.isStringLiteral(first)) checkSpecifier(first.text, node, false);
      if (MOCK_CALLS.has(callee)) add("real-product", lineOf(node), MESSAGES.mock(callee));
      if (BACKDOOR_CALLS.has(name) || (callee.includes(".") && BACKDOOR_METHODS.has(name)) || callee === "client.send" || /^(window\.)?localStorage\./.test(callee)) {
        add("real-product", lineOf(node), MESSAGES.backdoor(callee));
      }
      if (SKIP_METHODS.has(name) && callee.includes(".") && !callee.startsWith("vi.")) {
        const owner = callee.split(".")[0] ?? "";
        if (testBindings.has(owner) || owner === "describe" || owner === "ctx" || owner === "context") add("honest", lineOf(node), MESSAGES.skip(callee));
      }
      if (SLEEP_CALLS.has(callee) || SLEEP_CALLS.has(name)) add("honest", lineOf(node), MESSAGES.sleep(callee));
      if (name === "recordAssertionEvidence") {
        const last = node.arguments[node.arguments.length - 1];
        if (last && last.kind === ts.SyntaxKind.TrueKeyword) add("honest", lineOf(node), MESSAGES.selfGraded());
      }
      if (ts.isIdentifier(node.expression) && testBindings.has(node.expression.text) && first && !ts.isArrowFunction(first) && !ts.isFunctionExpression(first) && !ts.isObjectLiteralExpression(first)) {
        const last = node.arguments[node.arguments.length - 1];
        const body = last && (ts.isArrowFunction(last) || ts.isFunctionExpression(last)) ? last
          : last && ts.isIdentifier(last) ? localFunctions.get(last.text) : undefined;
        if (body || (last && ts.isIdentifier(last))) tests.push({ title: titleText(first, source), node, body });
      }
    }
    if (ts.isNewExpression(node) && calleeText(node.expression, source) === "URL") {
      const [first, base] = node.arguments ?? [];
      if (first && base && ts.isStringLiteral(first) && base.getText(source) === "import.meta.url" && /^(\.\.\/)+(apps|ee|packages|\.github)\//.test(first.text)) {
        add("real-product", lineOf(node), MESSAGES.sourceImport(first.text));
      }
    }
    if (ts.isIdentifier(node) && /__openwork|__OPENWORK/.test(node.text)) add("real-product", lineOf(node), MESSAGES.backdoor(node.text));
    if (ts.isStringLiteral(node) && /^(window\.)?__openwork/i.test(node.text)) add("real-product", lineOf(node), MESSAGES.backdoor(node.text));
    ts.forEachChild(node, visit);
  };
  visit(source);

  // A local helper observes if it (transitively) calls an observation.
  const observes = (body: ts.Node, observing: ReadonlySet<string>): boolean => {
    let found = false;
    const walk = (node: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(node)) {
        const callee = calleeText(node.expression, source);
        const head = callee.split(/[.(]/)[0] ?? "";
        if (head === "expect" || OBSERVE_METHODS.has(lastName(callee)) || observing.has(callee) || observingImports.has(head)) {
          found = true;
          return;
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(body);
    return found;
  };
  const observingLocals = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, body] of localFunctions) {
      if (!observingLocals.has(name) && observes(body, observingLocals)) {
        observingLocals.add(name);
        changed = true;
      }
    }
  }

  if (tests.length === 0) add("honest", 1, MESSAGES.unobserved("(no test found)"));
  for (const test of tests) {
    if (!test.body || !observes(test.body, observingLocals)) add("honest", lineOf(test.node), MESSAGES.unobserved(test.title));
  }
  return violations;
}
