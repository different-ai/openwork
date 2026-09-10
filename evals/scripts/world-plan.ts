import { readFileSync } from "node:fs";
import ts from "typescript";
import { validateWorldResources, validateWorldSurfaceSelection } from "../packages/env/src/world-resources.ts";
import type { WorldResources, WorldService, WorldSurface } from "../packages/env/src/world-resources.ts";

export interface PlannedWorld {
  file: string;
  binding: string;
  world: string;
  line: number;
  titles: string[];
  dynamicTitles: boolean;
  titlePrefixes: string[];
  resources: WorldResources | null;
}

function unwrapped(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
    ? unwrapped(node.expression) : node;
}

function property(node: ts.Expression | undefined, name: string): ts.Expression | undefined {
  if (!node) return undefined;
  const value = unwrapped(node);
  if (!ts.isObjectLiteralExpression(value)) throw new Error("World options/resources must be literal objects for pre-launch planning.");
  for (const item of value.properties) {
    if (ts.isSpreadAssignment(item)) throw new Error("Spread world options cannot be resolved before provisioning; declare them explicitly.");
    if (!ts.isPropertyAssignment(item) || (!ts.isIdentifier(item.name) && !ts.isStringLiteral(item.name))) throw new Error("World options/resources require plain named properties.");
  }
  const matches = value.properties.filter(item => ts.isPropertyAssignment(item) && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === name);
  if (matches.length > 1) throw new Error(`Duplicate world property ${name}.`);
  const match = matches[0];
  return match && ts.isPropertyAssignment(match) ? match.initializer : undefined;
}

function strings(node: ts.Expression | undefined): string[] {
  if (!node || !ts.isArrayLiteralExpression(unwrapped(node))) throw new Error("World resource lists must be literal arrays.");
  const value = unwrapped(node);
  if (!ts.isArrayLiteralExpression(value)) throw new Error("Expected resource array.");
  return value.elements.map(entry => {
    if (!ts.isStringLiteral(entry)) throw new Error("World resources must be literal strings.");
    return entry.text;
  });
}

function surface(value: string): WorldSurface {
  if (value === "appWeb" || value === "desktop" || value === "web") return value;
  throw new Error(`Unknown world surface ${value}`);
}

function service(value: string): WorldService {
  if (value === "den" || value === "mock") return value;
  throw new Error(`Unknown world service ${value}`);
}

function declaredResources(options: ts.Expression | undefined): { declaration?: ts.Expression; unresolved: boolean } {
  if (!options) return { unresolved: false };
  const value = unwrapped(options);
  if (!ts.isObjectLiteralExpression(value)) return { unresolved: true };
  const declarations = value.properties.filter(item => "name" in item && item.name && (
    ((ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === "resources")
    || (ts.isComputedPropertyName(item.name) && ts.isStringLiteral(item.name.expression) && item.name.expression.text === "resources")
  ));
  if (declarations.length > 1) throw new Error("Duplicate world property resources.");
  const declared = declarations[0];
  if (declared && !ts.isPropertyAssignment(declared)) throw new Error("Explicit resources must be a literal property assignment.");
  return {
    declaration: declared && ts.isPropertyAssignment(declared) ? declared.initializer : undefined,
    // Spreads/computed keys may override the declaration. Keep legacy options
    // lazy, but still validate any explicitly written resource declaration.
    unresolved: value.properties.some(item => !ts.isPropertyAssignment(item) || (!ts.isIdentifier(item.name) && !ts.isStringLiteral(item.name))),
  };
}

function nestedRegistration(node: ts.Node): boolean {
  // A suite callback (including aliased/dynamic describe wrappers) changes the
  // full title. Without executing it, retain the world for any group regex.
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return true;
  }
  return false;
}

/** Parse declarations only. Never import a spec or execute arrangement to discover resources. */
export function discoverWorlds(file: string, source = readFileSync(file, "utf8"), includeUnregistered = false): PlannedWorld[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specNames = new Set<string>();
  const directTestNames = new Set<string>();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "@openwork/testkit") continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      const imported = binding.propertyName?.text ?? binding.name.text;
      if (imported === "spec") specNames.add(binding.name.text);
      if (imported === "test") directTestNames.add(binding.name.text);
    }
  }
  const worlds = new Map<string, PlannedWorld>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "world"
      && ts.isIdentifier(node.expression.expression) && specNames.has(node.expression.expression.text)
      && (!ts.isVariableDeclaration(node.parent) || !ts.isIdentifier(node.parent.name))) {
      throw new Error(`${file}: spec.world must be assigned directly to a named test binding for planning.`);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
      const call = node.initializer;
      if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "world"
        && ts.isIdentifier(call.expression.expression) && specNames.has(call.expression.expression.text)) {
        const location = ast.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        let resources: WorldResources | null = null;
        try {
          const options = declaredResources(call.arguments[1]);
          const declared = options.declaration;
          if (declared) {
            const reason = property(declared, "nativeReason");
            if (reason && !ts.isStringLiteral(reason)) throw new Error("nativeReason must be a literal string.");
            resources = {
              surfaces: strings(property(declared, "surfaces")).map(surface),
              services: strings(property(declared, "services")).map(service),
              ...(reason && ts.isStringLiteral(reason) ? { nativeReason: reason.text } : {}),
            };
            validateWorldResources(resources);
            if (options.unresolved) resources = null;
          }
        } catch (error) {
          throw new Error(`${file}:${location}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (worlds.has(node.name.text)) throw new Error(`${file}:${location}: Ambiguous world binding ${node.name.text}.`);
        worlds.set(node.name.text, { file, binding: node.name.text, world: call.arguments[0]?.getText(ast) ?? "anonymous", line: location, titles: [], titlePrefixes: [], dynamicTitles: false, resources });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const binding of directTestNames) worlds.set(binding, { file, binding, world: "legacy test", line: 1, titles: [], titlePrefixes: [], dynamicTitles: false, resources: null });
  // Resolve simple const aliases to the same world, not duplicate provisioning units.
  const aliases = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isIdentifier(node.initializer)) {
      const world = worlds.get(node.initializer.text);
      if (world) {
        if (worlds.has(node.name.text)) throw new Error(`${file}: Ambiguous test alias ${node.name.text}.`);
        worlds.set(node.name.text, world);
      }
    }
    ts.forEachChild(node, aliases);
  };
  aliases(ast);
  // Without a type checker, shadowed names cannot safely be assigned to a world.
  const bindingCounts = new Map<string, number>();
  const checkBindings = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isImportSpecifier(node)) && ts.isIdentifier(node.name) && worlds.has(node.name.text)) {
      const count = (bindingCounts.get(node.name.text) ?? 0) + 1;
      bindingCounts.set(node.name.text, count);
      if (count > 1) throw new Error(`${file}: Ambiguous/shadowed test binding ${node.name.text}.`);
    }
    // Passing or transforming a test binding hides registrations from static selection.
    if (ts.isIdentifier(node) && worlds.has(node.text)) {
      const parent = node.parent;
      if ((ts.isPropertyAccessExpression(parent) && parent.name === node)
        || (ts.isPropertyAssignment(parent) && parent.name === node)) return;
      const supported = (ts.isVariableDeclaration(parent) && (parent.name === node || parent.initializer === node))
        || ts.isImportSpecifier(parent)
        || (ts.isCallExpression(parent) && parent.expression === node)
        || (ts.isPropertyAccessExpression(parent) && parent.expression === node);
      if (!supported) throw new Error(`${file}: Unresolved use of test binding ${node.text}; register tests directly or use a simple const alias.`);
    }
    ts.forEachChild(node, checkBindings);
  };
  checkBindings(ast);
  const registrations = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      // skipIf/runIf/each configuration calls are not registrations.
      if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
        ts.forEachChild(node, registrations);
        return;
      }
      let target: ts.Expression = node.expression;
      const modifiers: string[] = [];
      while (ts.isPropertyAccessExpression(target) || ts.isCallExpression(target) || ts.isTaggedTemplateExpression(target)) {
        if (ts.isPropertyAccessExpression(target)) modifiers.push(target.name.text);
        target = ts.isTaggedTemplateExpression(target) ? target.tag : target.expression;
      }
      if (ts.isIdentifier(target)) {
        const world = worlds.get(target.text);
        if (world) {
          if (modifiers.some(name => !["skip", "only", "todo", "skipIf", "runIf", "each", "for", "concurrent", "sequential", "fails"].includes(name))) {
            throw new Error(`${file}: Unresolved test modifier ${modifiers.join(".")} on ${target.text}.`);
          }
          if (ts.isVariableDeclaration(node.parent)) throw new Error(`${file}: Configured test aliases are unresolved; use a simple const alias and configure each registration.`);
          const title = node.arguments[0];
          if (nestedRegistration(node) || modifiers.includes("each") || modifiers.includes("for")) world.dynamicTitles = true;
          if (title && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) world.titles.push(title.text);
          else if (title && ts.isTemplateExpression(title) && title.head.text) world.titlePrefixes.push(title.head.text);
          else world.dynamicTitles = true;
        }
      }
    }
    ts.forEachChild(node, registrations);
  };
  registrations(ast);
  const result = [...new Set(worlds.values())].filter(world => includeUnregistered || world.titles.length > 0 || world.titlePrefixes.length > 0 || world.dynamicTitles);
  if (result.length === 0) result.push({ file, binding: "unknown", world: "legacy/unresolved", line: 1, titles: [], titlePrefixes: [], dynamicTitles: true, resources: null });
  return result;
}

export function selectWorlds(worlds: PlannedWorld[], pattern?: string, casePrefix?: string): PlannedWorld[] {
  if (!pattern) return worlds;
  const expression = new RegExp(pattern);
  // Runner callers may have only Vitest's pattern. Recognize the CLI's exact
  // case-ID form; arbitrary regexes stay conservative for partial titles.
  if (casePrefix === undefined && pattern.startsWith("^") && pattern.endsWith("(?:\\s|$)")) {
    const candidate = pattern.slice(1, -8);
    if (/^[A-Z]+-\d+$/.test(candidate)) casePrefix = candidate;
  }
  const exactCasePattern = casePrefix === undefined ? undefined : `^${casePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`;
  return worlds.filter(world => world.dynamicTitles || world.titles.some(title => expression.test(title)) || world.titlePrefixes.some(prefix => {
    // Only exact case-prefix selection can prove disjointness with a partial title.
    if (!casePrefix || pattern !== exactCasePattern) return true;
    return prefix.startsWith(casePrefix) || casePrefix.startsWith(prefix);
  }));
}

export function planWorlds(files: readonly string[], options: { pattern?: string; surface?: string; casePrefix?: string; sources?: readonly string[] } = {}) {
  const worlds = selectWorlds(files.flatMap((file, index) => discoverWorlds(file, options.sources?.[index])), options.pattern, options.casePrefix);
  if (worlds.length === 0) throw new Error("No world declarations matched; refusing empty provisioning plan.");
  for (const world of worlds) {
    if (options.surface && !world.resources) throw new Error(`${world.file}:${world.line}: surface selection cannot validate legacy/unresolved world ${world.world}.`);
    if (world.resources) validateWorldSurfaceSelection(world.resources, options.surface);
  }
  return {
    worlds,
    surfaces: [...new Set(worlds.flatMap(world => world.resources?.surfaces ?? []))],
    services: [...new Set(worlds.flatMap(world => world.resources?.services ?? []))],
    legacy: worlds.filter(world => !world.resources).map(world => `${world.file}:${world.line}`),
  };
}

export function worldContract(world: PlannedWorld): string {
  if (!world.resources) return `${world.binding}: resources=unknown; legacy; lazy provision only`;
  return `${world.binding}: surfaces=[${world.resources.surfaces.join(", ")}]; services=[${world.resources.services.join(", ")}]${world.resources.nativeReason ? `; nativeReason=${world.resources.nativeReason}` : ""}`;
}
