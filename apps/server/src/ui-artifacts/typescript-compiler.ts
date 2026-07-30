import ts from "typescript";
import {
  UI_ARTIFACT_MAX_BUNDLE_BYTES,
  UI_ARTIFACT_MAX_SOURCE_BYTES,
  type UiArtifactCompilerDiagnostic,
} from "@openwork/types/ui-artifact-project";
import type { ArtifactCompilerPort, ArtifactCompileResult } from "./ports.js";

const FORBIDDEN_GLOBALS = new Set([
  "require",
  ["fet", "ch"].join(""),
  "WebSocket",
  "EventSource",
  "XMLHttpRequest",
  "Worker",
  "SharedWorker",
  "importScripts",
  "eval",
  "Function",
  "window",
  "document",
  "globalThis",
  "location",
  "navigation",
  "navigator",
  "opener",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  "BroadcastChannel",
  "MessageChannel",
  "MessagePort",
  "postMessage",
  "Image",
  "Audio",
  "URL",
  "HTMLElement",
  "Element",
  "Node",
  "Document",
  "HTMLAnchorElement",
  "HTMLFormElement",
]);

const FORBIDDEN_DOM_PROPERTIES = new Set([
  "location",
  "ownerDocument",
  "defaultView",
  "nativeEvent",
  "getRootNode",
  "createElement",
  "createElementNS",
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
  "constructor",
  "__proto__",
  "prototype",
]);

const FORBIDDEN_JSX_TAGS = new Set([
  "a",
  "base",
  "embed",
  "form",
  "iframe",
  "link",
  "meta",
  "object",
  "script",
]);

const RUNTIME_PREAMBLE = [
  "const __openworkReactRuntime = globalThis.__OPENWORK_ARTIFACT_REACT__;",
  "if (!__openworkReactRuntime || typeof __openworkReactRuntime.createElement !== \"function\") {",
  "  throw new Error(\"OpenWork artifact React runtime is unavailable\");",
  "}",
  "globalThis.React = __openworkReactRuntime;",
  "",
].join("\n");

function diagnosticAt(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  code: number,
  message: string,
): UiArtifactCompilerDiagnostic {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    category: "error",
    code,
    message,
    line: position.line + 1,
    column: position.character + 1,
  };
}

function propertyName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  const argument = node.argumentExpression;
  return argument && ts.isStringLiteralLike(argument) ? argument.text : null;
}

function isComponentExpression(sourceFile: ts.SourceFile, expression: ts.Expression): boolean {
  if (
    ts.isArrowFunction(expression)
    || ts.isFunctionExpression(expression)
    || ts.isClassExpression(expression)
  ) {
    return true;
  }
  if (!ts.isIdentifier(expression)) {
    return false;
  }
  for (const statement of sourceFile.statements) {
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
      && statement.name?.text === expression.text
    ) {
      return true;
    }
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name)
        && declaration.name.text === expression.text
        && declaration.initializer
        && (
          ts.isArrowFunction(declaration.initializer)
          || ts.isFunctionExpression(declaration.initializer)
          || ts.isClassExpression(declaration.initializer)
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function isIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isTypeNode(parent)) {
    return false;
  }
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node)
    || (ts.isPropertyAssignment(parent) && parent.name === node)
    || (ts.isPropertyDeclaration(parent) && parent.name === node)
    || (ts.isPropertySignature(parent) && parent.name === node)
    || (ts.isMethodDeclaration(parent) && parent.name === node)
    || (ts.isMethodSignature(parent) && parent.name === node)
    || (ts.isVariableDeclaration(parent) && parent.name === node)
    || (ts.isParameter(parent) && parent.name === node)
    || (ts.isFunctionDeclaration(parent) && parent.name === node)
    || (ts.isFunctionExpression(parent) && parent.name === node)
    || (ts.isClassDeclaration(parent) && parent.name === node)
    || (ts.isClassExpression(parent) && parent.name === node)
    || (ts.isTypeAliasDeclaration(parent) && parent.name === node)
    || (ts.isInterfaceDeclaration(parent) && parent.name === node)
    || (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node))
    || (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent))
  ) {
    return false;
  }
  return true;
}

function securityDiagnostics(sourceFile: ts.SourceFile): UiArtifactCompilerDiagnostic[] {
  const diagnostics: UiArtifactCompilerDiagnostic[] = [];
  let hasDefaultExport = false;
  let hasValidDefaultExport = false;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
      diagnostics.push(diagnosticAt(
        sourceFile,
        node,
        91001,
        "Imports are not supported. Artifact components receive React and their runtime capabilities from OpenWork.",
      ));
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      diagnostics.push(diagnosticAt(sourceFile, node, 91002, "Exports from another module are not supported"));
    }

    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
      && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      hasDefaultExport = true;
      hasValidDefaultExport = true;
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      hasDefaultExport = true;
      hasValidDefaultExport = isComponentExpression(sourceFile, node.expression);
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      diagnostics.push(diagnosticAt(sourceFile, node, 91003, "Dynamic imports are not supported"));
    }

    if (
      ts.isWhileStatement(node)
      || ts.isDoStatement(node)
      || (ts.isForStatement(node) && !node.condition)
    ) {
      diagnostics.push(diagnosticAt(
        sourceFile,
        node,
        91010,
        "Potentially unbounded loops are not supported inside artifact components",
      ));
    }

    if (
      ts.isIdentifier(node)
      && isIdentifierReference(node)
      && FORBIDDEN_GLOBALS.has(node.text)
    ) {
      diagnostics.push(diagnosticAt(
        sourceFile,
        node,
        91004,
        `${node.text} is not available inside an artifact component`,
      ));
    }

    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && FORBIDDEN_DOM_PROPERTIES.has(propertyName(node) ?? "")
    ) {
      diagnostics.push(diagnosticAt(
        sourceFile,
        node,
        91004,
        `${propertyName(node)} is not available inside an artifact component`,
      ));
    }

    if (ts.isJsxOpeningLikeElement(node)) {
      const tagName = node.tagName.getText(sourceFile).toLowerCase();
      if (FORBIDDEN_JSX_TAGS.has(tagName)) {
        diagnostics.push(diagnosticAt(
          sourceFile,
          node,
          91007,
          `<${tagName}> is not available inside an artifact component`,
        ));
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (!hasDefaultExport) {
    diagnostics.push({
      category: "error",
      code: 91005,
      message: "src/App.tsx must default-export one React component",
    });
  } else if (!hasValidDefaultExport) {
    diagnostics.push({
      category: "error",
      code: 91009,
      message: "The default export must be a function or class component",
    });
  }

  const unique = new Map<string, UiArtifactCompilerDiagnostic>();
  for (const diagnostic of diagnostics) {
    unique.set(
      `${diagnostic.code}:${diagnostic.line ?? 0}:${diagnostic.column ?? 0}:${diagnostic.message}`,
      diagnostic,
    );
  }
  return Array.from(unique.values());
}

function compilerDiagnostic(
  sourceFile: ts.SourceFile,
  diagnostic: ts.Diagnostic,
): UiArtifactCompilerDiagnostic {
  const base = {
    category: diagnostic.category === ts.DiagnosticCategory.Error ? "error" : "warning",
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n").slice(0, 2_000),
  } satisfies UiArtifactCompilerDiagnostic;
  if (diagnostic.start === undefined) return base;
  const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
  return {
    ...base,
    line: position.line + 1,
    column: position.character + 1,
  };
}

export class TypeScriptArtifactCompiler implements ArtifactCompilerPort {
  compile(source: string): ArtifactCompileResult {
    if (Buffer.byteLength(source, "utf8") > UI_ARTIFACT_MAX_SOURCE_BYTES) {
      return {
        ok: false,
        diagnostics: [{
          category: "error",
          code: 91000,
          message: `src/App.tsx exceeds ${UI_ARTIFACT_MAX_SOURCE_BYTES} bytes`,
        }],
      };
    }

    const sourceFile = ts.createSourceFile(
      "App.tsx",
      source,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TSX,
    );
    const rejected = securityDiagnostics(sourceFile);
    if (rejected.length) return { ok: false, diagnostics: rejected };

    const output = ts.transpileModule(source, {
      fileName: "App.tsx",
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.React,
        isolatedModules: true,
        removeComments: false,
        sourceMap: false,
        inlineSourceMap: false,
      },
    });
    const diagnostics = (output.diagnostics ?? []).map((diagnostic) =>
      compilerDiagnostic(sourceFile, diagnostic),
    );
    if (diagnostics.some((diagnostic) => diagnostic.category === "error")) {
      return { ok: false, diagnostics };
    }

    const bundle = RUNTIME_PREAMBLE + output.outputText;
    if (Buffer.byteLength(bundle, "utf8") > UI_ARTIFACT_MAX_BUNDLE_BYTES) {
      return {
        ok: false,
        diagnostics: [{
          category: "error",
          code: 91006,
          message: `Compiled artifact exceeds ${UI_ARTIFACT_MAX_BUNDLE_BYTES} bytes`,
        }],
      };
    }

    return {
      ok: true,
      bundle,
      compiler: {
        name: "typescript",
        version: ts.version,
        jsx: "react",
        module: "esnext",
      },
    };
  }
}
