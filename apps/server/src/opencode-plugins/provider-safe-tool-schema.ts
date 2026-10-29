// Providers validate tool input schemas differently, and one schema a provider
// rejects fails every request in the conversation. These rules cover the
// rejections seen so far:
// - `$ref`: strict validators (DeepSeek, Groq) reject pointers that an engine
//   moved or dropped, and some reject recursion outright.
// - top-level anyOf/oneOf/allOf: Anthropic rejects them.
// - large size bounds: grammar-constrained providers (Fireworks, xAI,
//   llama.cpp) turn each bound into grammar rules, capped at 2^21 - 1 per request.
export const MAX_SCHEMA_SIZE_BOUND = 32_000;

const COMBINATORS = ["anyOf", "oneOf", "allOf"];
const SIZE_BOUNDS = ["maxLength", "minLength", "maxItems", "minItems"];
const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions"];
const SCHEMA_LISTS = [...COMBINATORS, "prefixItems"];
const SCHEMAS = ["items", "additionalProperties", "not", "contains", "propertyNames", "if", "then", "else"];

type Schema = Record<string, unknown>;
const isSchema = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);

/** What would make a provider reject this tool input schema; empty when it is safe to send. */
export function providerSchemaProblems(schema: unknown): string[] {
  if (!isSchema(schema) || schema.type !== "object") return ["the root is not an object schema"];
  const problems = COMBINATORS.filter(key => key in schema).map(key => `top-level ${key}`);
  const visit = (node: unknown, path: string) => {
    if (!isSchema(node)) return;
    if ("$ref" in node) problems.push(`$ref at ${path || "/"}`);
    for (const key of SIZE_BOUNDS) {
      const bound = node[key];
      if (typeof bound === "number" && bound > MAX_SCHEMA_SIZE_BOUND) problems.push(`${key} ${bound} at ${path || "/"}`);
    }
    for (const key of SCHEMA_MAPS) {
      const children = node[key];
      if (isSchema(children)) for (const [name, child] of Object.entries(children)) visit(child, `${path}/${key}/${name}`);
    }
    for (const key of SCHEMA_LISTS) {
      const children = node[key];
      if (Array.isArray(children)) children.forEach((child, index) => visit(child, `${path}/${key}/${index}`));
    }
    for (const key of SCHEMAS) visit(node[key], `${path}/${key}`);
  };
  visit(schema, "");
  return problems;
}

/** Adds the tool unless a provider would reject its schema, so one bad tool is missing instead of every request failing. */
export function addProviderSafeTool<T extends { name: string; input: unknown }>(editor: { add(tool: T): void }, tool: T) {
  const problems = providerSchemaProblems(tool.input);
  if (problems.length) {
    console.warn(`OpenWork left out the ${tool.name} tool because providers would reject its schema: ${problems.join("; ")}`);
    return false;
  }
  editor.add(tool);
  return true;
}
