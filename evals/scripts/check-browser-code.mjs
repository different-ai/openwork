import ts from "typescript";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Enforce the browser/process boundary using bindings, not regex matches in strings. */
export function checkBrowserCode(program, root, include) {
  const checker = program.getTypeChecker();
  const failures = [];
  const callbacks = [];
  const calls = [];
  const names = new Set(["browserScript", "evaluate", "eval", "evalIn", "rawEvalIn", "evaluateOnSurface", "callFunction", "callFunctionOnSurface", "addInitScript", "inPage", "waitFor", "waitForBehavior", "pollExpression", "resilientRead", "browserSource", "memberRefreshAndWait", "waitForDenState"]);
  function report(node, message) {
    const file = node.getSourceFile();
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart());
    failures.push(`${relative(root, file.fileName)}:${line + 1}:${character + 1}: ${message}`);
  }
  function unwrap(node) { while (ts.isParenthesizedExpression(node)) node = node.expression; return node; }
  function callbackFor(node, seen = new Set()) {
    node = unwrap(node);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) return node;
    if (!ts.isIdentifier(node)) return;
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    if (!symbol || seen.has(symbol)) return;
    seen.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) return callbackFor(declaration.initializer, seen);
      if (ts.isFunctionDeclaration(declaration)) return declaration;
    }
  }
  function resultProblem(type, seen = new Set()) {
    if (seen.has(type)) return;
    seen.add(type);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) return;
    if (type.isUnionOrIntersection()) {
      for (const part of type.types) { const problem = resultProblem(part, seen); if (problem) return problem; }
      return;
    }
    if (type.flags & (ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike)) return "bigint/symbol";
    if (!(type.flags & ts.TypeFlags.Object)) return;
    if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length) return "function";
    if (type.getSymbol()?.declarations?.some(d => /lib\.dom/.test(d.getSourceFile().fileName))) return "DOM object";
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      for (const item of checker.getTypeArguments(type)) { const problem = resultProblem(item, seen); if (problem) return problem; }
      return;
    }
    for (const property of checker.getPropertiesOfType(type)) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (declaration) { const problem = resultProblem(checker.getTypeOfSymbolAtLocation(property, declaration), seen); if (problem) return problem; }
    }
  }
  function checkCallback(fn) {
    if (callbacks.includes(fn)) return;
    callbacks.push(fn);
    const signature = checker.getSignatureFromDeclaration(fn);
    if (signature) {
      const type = checker.getAwaitedType(checker.getReturnTypeOfSignature(signature));
      const problem = type && resultProblem(type);
      if (problem) report(fn, `Browser result contains a ${problem}; return a plain data projection instead.`);
    }
    if (!fn.body) { report(fn, "Browser callbacks must have an executable body, not a native/bound function."); return; }
    function walk(node) {
      if (ts.isTypeNode(node)) return;
      if (ts.isExpressionStatement(node) && ts.isIdentifier(node.expression)) report(node, "Bare browser expression has no effect; pass data rather than source fragments.");
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        const propertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node)
          || ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node);
        if (!propertyName) {
          const symbol = ts.isShorthandPropertyAssignment(parent) ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(node);
          const declarations = symbol?.declarations ?? [];
          const local = declarations.some(d => d.getSourceFile() === fn.getSourceFile() && d.pos >= fn.pos && d.end <= fn.end);
          const browserGlobal = declarations.length && declarations.some(d => /[\\/]typescript[\\/]lib[\\/]lib\.(dom|es|decorators)/.test(d.getSourceFile().fileName));
          if (declarations.length && !local && !browserGlobal) report(node, `Browser callback captures '${node.text}'. Pass it through browserScript(callback, [args]) instead.`);
        }
      }
      ts.forEachChild(node, walk);
    }
    walk(fn);
  }
  for (const file of program.getSourceFiles()) {
    if (include && !include(file.fileName)) continue;
    if (!(file.fileName.startsWith(resolve(root, "evals")) || file.fileName.endsWith("/packages/handsfree/test/e2e/browser.ts")) || file.fileName.includes("node_modules") || file.isDeclarationFile) continue;
    function visit(node) {
      if (ts.isCallExpression(node)) {
        let name = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : "";
        const symbol = checker.getSymbolAtLocation(node.expression);
        if (symbol?.flags & ts.SymbolFlags.Alias) name = checker.getAliasedSymbol(symbol).name;
        if (names.has(name)) {
          calls.push(node);
          if (name === "browserScript" && node.arguments[1]) {
            const problem = resultProblem(checker.getTypeAtLocation(node.arguments[1]));
            if (problem) report(node.arguments[1], `Browser arguments contain a ${problem}; pass plain data instead.`);
          }
          for (const arg of node.arguments) {
            const fn = callbackFor(arg);
            if (fn) checkCallback(fn);
          }
          const index = ["browserScript", "browserSource"].includes(name) ? 0 : name === "waitForDenState" ? 2 : name === "eval" ? (node.arguments.length > 1 && checker.typeToString(checker.getTypeAtLocation(node.arguments[0])).includes("Surface") ? 1 : 0) : 1;
          const arg = node.arguments[index];
          if (arg && checker.getTypeAtLocation(arg).flags & ts.TypeFlags.StringLike) report(arg, "Raw browser code strings are forbidden; use a typed callback.");
        }
        if (name === "send" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
          && ["Runtime.evaluate", "Runtime.callFunctionOn", "Page.addScriptToEvaluateOnNewDocument"].includes(node.arguments[0].text)
          && !file.fileName.endsWith("/cdp/src/cdp.ts")) report(node, "Use the typed CDP evaluation/init-script API.");
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  // Check the browser bodies even when unrelated legacy server imports fail the full eval compiler.
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    if (!diagnostic.file || diagnostic.start === undefined) continue;
    if (calls.some(fn => fn.getSourceFile() === diagnostic.file && diagnostic.start >= fn.getStart() && diagnostic.start < fn.end)
      || /\/cdp\/src\/(browser-script|browser-globals|cdp|surface)\.(ts|d\.ts)$/.test(diagnostic.file.fileName)) {
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      failures.push(`${relative(root, diagnostic.file.fileName)}:${line + 1}:${character + 1}: TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
    }
  }
  return { failures: [...new Set(failures)], count: callbacks.length };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const configPath = resolve(root, "evals/tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, " "));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(root, "evals"));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const { failures, count } = checkBrowserCode(program, root);
  if (failures.length) { console.error(failures.join("\n")); process.exitCode = 1; }
  else console.log(`Checked ${count} browser callbacks: no raw code strings, captured test variables, or browser type errors.`);
}
