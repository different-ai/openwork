import { tsPlugin } from "@sveltejs/acorn-typescript";
import { Parser } from "acorn";

// The engine transpiles scripts as TypeScript, so annotated scripts must parse here too.
const ScriptParser = Parser.extend(tsPlugin());

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bindsDiscovery(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.type === "Identifier") return value.name === "tools" || value.name === "search";
  if (value.type === "Property") return bindsDiscovery(value.value);
  if (value.type === "AssignmentPattern") return bindsDiscovery(value.left);
  return Object.values(value).some(entry => Array.isArray(entry) ? entry.some(bindsDiscovery) : bindsDiscovery(entry));
}

/** The pinned engine has a bare search() intrinsic, but no tools.search alias.
 * Rewrite syntax before execution, never retry a script that may have written.
 * Source ranges leave strings, comments, and unrelated tool paths unchanged. */
export function nativeDiscoveryCode(code: string): string {
  if (!code.includes("search")) return code;
  let tree: unknown;
  try {
    tree = ScriptParser.parse(code, { ecmaVersion: "latest", locations: true, allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
  } catch {
    // Let the engine own syntax diagnostics.
    return code;
  }
  const ranges: Array<{ start: number; end: number }> = [];
  let shadowed = false;
  function visit(value: unknown): void {
    if (!record(value)) return;
    if ((value.type === "VariableDeclarator" || value.type === "FunctionDeclaration" || value.type === "FunctionExpression" || value.type === "ClassDeclaration" || value.type === "ClassExpression") && bindsDiscovery(value.id)
      || value.type === "CatchClause" && bindsDiscovery(value.param)
      || Array.isArray(value.params) && value.params.some(bindsDiscovery)) shadowed = true;
    if (value.type === "MemberExpression" && record(value.object) && value.object.type === "Identifier" && value.object.name === "tools"
      && record(value.property) && (value.computed === true ? value.property.type === "Literal" && value.property.value === "search"
        : value.property.type === "Identifier" && value.property.name === "search")
      && typeof value.start === "number" && typeof value.end === "number") ranges.push({ start: value.start, end: value.end });
    for (const entry of Object.values(value)) {
      if (Array.isArray(entry)) entry.forEach(visit);
      else visit(entry);
    }
  }
  visit(tree);
  if (shadowed) return code;
  for (const { start, end } of ranges.sort((left, right) => right.start - left.start)) code = code.slice(0, start) + "search" + code.slice(end);
  return code;
}
