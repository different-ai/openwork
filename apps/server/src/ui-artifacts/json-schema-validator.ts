import { stableJson } from "./filesystem-security.js";
import type {
  ArtifactDataDiagnostic,
  ArtifactDataValidationResult,
  ArtifactDataValidatorPort,
} from "./ports.js";

const SUPPORTED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "default",
  "examples",
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
]);
const JSON_TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 2_048;
const MAX_DIAGNOSTICS = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointer(path: string, key: string | number): string {
  const segment = String(key).replace(/~/g, "~0").replace(/\//g, "~1");
  return `${path}/${segment}`;
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  if (expected === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (expected === "object") return isRecord(value);
  if (expected === "array") return Array.isArray(value);
  if (expected === "null") return value === null;
  return typeof value === expected;
}

export class SafeJsonSchemaDataValidator implements ArtifactDataValidatorPort {
  validate(schema: Record<string, unknown>, data: unknown): ArtifactDataValidationResult {
    const diagnostics: ArtifactDataDiagnostic[] = [];
    let schemaNodes = 0;
    const add = (
      path: string,
      schemaPath: string,
      keyword: string,
      message: string,
      target = diagnostics,
    ) => {
      if (target.length >= MAX_DIAGNOSTICS) return;
      target.push({ path, schemaPath, keyword, message });
    };
    let shapeNodes = 0;
    const validateShape = (candidate: unknown, schemaPath: string, depth: number): void => {
      shapeNodes += 1;
      if (depth > MAX_SCHEMA_DEPTH || shapeNodes > MAX_SCHEMA_NODES) {
        add("", schemaPath, "schema", "JSON Schema exceeds the supported complexity limit");
        return;
      }
      if (typeof candidate === "boolean") return;
      if (!isRecord(candidate)) {
        add("", schemaPath, "schema", "Schema nodes must be objects or booleans");
        return;
      }
      for (const key of Object.keys(candidate)) {
        if (!SUPPORTED_KEYWORDS.has(key) && !key.startsWith("x-")) {
          add("", pointer(schemaPath, key), key, `Unsupported JSON Schema keyword: ${key}`);
        }
      }
      const type = candidate.type;
      if (type !== undefined) {
        const types = typeof type === "string"
          ? [type]
          : Array.isArray(type) && type.every((entry) => typeof entry === "string")
            ? type
            : null;
        if (!types || !types.length || types.some((entry) => !JSON_TYPES.has(entry))) {
          add("", pointer(schemaPath, "type"), "type", "type must contain supported JSON type names");
        }
      }
      if (candidate.enum !== undefined && (!Array.isArray(candidate.enum) || candidate.enum.length === 0)) {
        add("", pointer(schemaPath, "enum"), "enum", "enum must be a non-empty array");
      }
      if (
        candidate.required !== undefined
        && (!Array.isArray(candidate.required) || !candidate.required.every((entry) => typeof entry === "string"))
      ) {
        add("", pointer(schemaPath, "required"), "required", "required must be an array of property names");
      }
      if (candidate.properties !== undefined) {
        if (!isRecord(candidate.properties)) {
          add("", pointer(schemaPath, "properties"), "properties", "properties must be an object");
        } else {
          for (const [name, propertySchema] of Object.entries(candidate.properties)) {
            validateShape(propertySchema, pointer(pointer(schemaPath, "properties"), name), depth + 1);
          }
        }
      }
      if (
        candidate.additionalProperties !== undefined
        && typeof candidate.additionalProperties !== "boolean"
        && !isRecord(candidate.additionalProperties)
      ) {
        add("", pointer(schemaPath, "additionalProperties"), "additionalProperties", "additionalProperties must be a schema or boolean");
      } else if (isRecord(candidate.additionalProperties)) {
        validateShape(candidate.additionalProperties, pointer(schemaPath, "additionalProperties"), depth + 1);
      }
      if (candidate.items !== undefined) {
        validateShape(candidate.items, pointer(schemaPath, "items"), depth + 1);
      }
      for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
        const branches = candidate[keyword];
        if (branches === undefined) continue;
        if (!Array.isArray(branches) || branches.length === 0) {
          add("", pointer(schemaPath, keyword), keyword, `${keyword} must be a non-empty array`);
          continue;
        }
        branches.forEach((branch, index) =>
          validateShape(branch, pointer(pointer(schemaPath, keyword), index), depth + 1),
        );
      }
      if (candidate.not !== undefined) {
        validateShape(candidate.not, pointer(schemaPath, "not"), depth + 1);
      }
      for (const keyword of ["minItems", "maxItems", "minLength", "maxLength"] as const) {
        const bound = candidate[keyword];
        if (bound !== undefined && (typeof bound !== "number" || !Number.isSafeInteger(bound) || bound < 0)) {
          add("", pointer(schemaPath, keyword), keyword, `${keyword} must be a non-negative integer`);
        }
      }
      for (const keyword of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
        const bound = candidate[keyword];
        if (bound !== undefined && (typeof bound !== "number" || !Number.isFinite(bound))) {
          add("", pointer(schemaPath, keyword), keyword, `${keyword} must be a finite number`);
        }
      }
      if (
        candidate.multipleOf !== undefined
        && (typeof candidate.multipleOf !== "number" || !Number.isFinite(candidate.multipleOf) || candidate.multipleOf <= 0)
      ) {
        add("", pointer(schemaPath, "multipleOf"), "multipleOf", "multipleOf must be a finite number greater than zero");
      }
    };

    const visit = (
      candidate: unknown,
      value: unknown,
      path: string,
      schemaPath: string,
      depth: number,
      target = diagnostics,
    ): void => {
      schemaNodes += 1;
      if (depth > MAX_SCHEMA_DEPTH || schemaNodes > MAX_SCHEMA_NODES) {
        add(path, schemaPath, "schema", "JSON Schema exceeds the supported complexity limit", target);
        return;
      }
      if (candidate === true) return;
      if (candidate === false) {
        add(path, schemaPath, "false", "Value is rejected by the false schema", target);
        return;
      }
      if (!isRecord(candidate)) {
        add(path, schemaPath, "schema", "Schema nodes must be objects or booleans", target);
        return;
      }
      for (const key of Object.keys(candidate)) {
        if (!SUPPORTED_KEYWORDS.has(key) && !key.startsWith("x-")) {
          add(path, pointer(schemaPath, key), key, `Unsupported JSON Schema keyword: ${key}`, target);
        }
      }

      const type = candidate.type;
      if (type !== undefined) {
        const types = typeof type === "string"
          ? [type]
          : Array.isArray(type) && type.every((entry) => typeof entry === "string")
            ? type
            : null;
        if (!types || !types.length || types.some((entry) => !JSON_TYPES.has(entry))) {
          add(path, pointer(schemaPath, "type"), "type", "type must contain supported JSON type names", target);
          return;
        }
        if (!types.some((entry) => matchesType(value, entry))) {
          add(path, pointer(schemaPath, "type"), "type", `Expected ${types.join(" or ")}, received ${valueType(value)}`, target);
          return;
        }
      }

      if (Object.hasOwn(candidate, "const") && stableJson(value) !== stableJson(candidate.const)) {
        add(path, pointer(schemaPath, "const"), "const", "Value does not match const", target);
      }
      if (Object.hasOwn(candidate, "enum")) {
        if (!Array.isArray(candidate.enum) || candidate.enum.length === 0) {
          add(path, pointer(schemaPath, "enum"), "enum", "enum must be a non-empty array", target);
        } else if (!candidate.enum.some((entry) => stableJson(entry) === stableJson(value))) {
          add(path, pointer(schemaPath, "enum"), "enum", "Value is not one of the allowed enum values", target);
        }
      }

      for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
        const branches = candidate[keyword];
        if (branches === undefined) continue;
        if (!Array.isArray(branches) || branches.length === 0) {
          add(path, pointer(schemaPath, keyword), keyword, `${keyword} must be a non-empty array`, target);
          continue;
        }
        const branchResults = branches.map((branch, index) => {
          const branchDiagnostics: ArtifactDataDiagnostic[] = [];
          visit(branch, value, path, pointer(pointer(schemaPath, keyword), index), depth + 1, branchDiagnostics);
          return branchDiagnostics;
        });
        const matches = branchResults.filter((result) => result.length === 0).length;
        if (keyword === "allOf" && matches !== branches.length) {
          add(path, pointer(schemaPath, keyword), keyword, "Value does not satisfy every allOf branch", target);
        }
        if (keyword === "anyOf" && matches === 0) {
          add(path, pointer(schemaPath, keyword), keyword, "Value does not satisfy any anyOf branch", target);
        }
        if (keyword === "oneOf" && matches !== 1) {
          add(path, pointer(schemaPath, keyword), keyword, "Value must satisfy exactly one oneOf branch", target);
        }
      }
      if (candidate.not !== undefined) {
        const branchDiagnostics: ArtifactDataDiagnostic[] = [];
        visit(candidate.not, value, path, pointer(schemaPath, "not"), depth + 1, branchDiagnostics);
        if (branchDiagnostics.length === 0) {
          add(path, pointer(schemaPath, "not"), "not", "Value satisfies a forbidden schema", target);
        }
      }

      if (isRecord(value)) {
        const properties = candidate.properties;
        if (properties !== undefined && !isRecord(properties)) {
          add(path, pointer(schemaPath, "properties"), "properties", "properties must be an object", target);
        }
        const propertySchemas = isRecord(properties) ? properties : {};
        const required = candidate.required;
        if (required !== undefined) {
          if (!Array.isArray(required) || !required.every((entry) => typeof entry === "string")) {
            add(path, pointer(schemaPath, "required"), "required", "required must be an array of property names", target);
          } else {
            for (const name of required) {
              if (!Object.hasOwn(value, name)) {
                add(pointer(path, name), pointer(schemaPath, "required"), "required", `Missing required property: ${name}`, target);
              }
            }
          }
        }
        for (const [name, propertyValue] of Object.entries(value)) {
          if (Object.hasOwn(propertySchemas, name)) {
            visit(
              propertySchemas[name],
              propertyValue,
              pointer(path, name),
              pointer(pointer(schemaPath, "properties"), name),
              depth + 1,
              target,
            );
            continue;
          }
          if (candidate.additionalProperties === false) {
            add(pointer(path, name), pointer(schemaPath, "additionalProperties"), "additionalProperties", `Unexpected property: ${name}`, target);
          } else if (isRecord(candidate.additionalProperties) || typeof candidate.additionalProperties === "boolean") {
            visit(
              candidate.additionalProperties,
              propertyValue,
              pointer(path, name),
              pointer(schemaPath, "additionalProperties"),
              depth + 1,
              target,
            );
          }
        }
      }

      if (Array.isArray(value)) {
        if (
          candidate.minItems !== undefined
          && (typeof candidate.minItems !== "number" || !Number.isInteger(candidate.minItems) || candidate.minItems < 0)
        ) {
          add(path, pointer(schemaPath, "minItems"), "minItems", "minItems must be a non-negative integer", target);
        } else if (typeof candidate.minItems === "number" && value.length < candidate.minItems) {
          add(path, pointer(schemaPath, "minItems"), "minItems", `Expected at least ${candidate.minItems} items`, target);
        }
        if (
          candidate.maxItems !== undefined
          && (typeof candidate.maxItems !== "number" || !Number.isInteger(candidate.maxItems) || candidate.maxItems < 0)
        ) {
          add(path, pointer(schemaPath, "maxItems"), "maxItems", "maxItems must be a non-negative integer", target);
        } else if (typeof candidate.maxItems === "number" && value.length > candidate.maxItems) {
          add(path, pointer(schemaPath, "maxItems"), "maxItems", `Expected at most ${candidate.maxItems} items`, target);
        }
        if (candidate.items !== undefined) {
          value.forEach((entry, index) =>
            visit(candidate.items, entry, pointer(path, index), pointer(schemaPath, "items"), depth + 1, target),
          );
        }
      }

      if (typeof value === "string") {
        if (typeof candidate.minLength === "number" && value.length < candidate.minLength) {
          add(path, pointer(schemaPath, "minLength"), "minLength", `Expected at least ${candidate.minLength} characters`, target);
        }
        if (typeof candidate.maxLength === "number" && value.length > candidate.maxLength) {
          add(path, pointer(schemaPath, "maxLength"), "maxLength", `Expected at most ${candidate.maxLength} characters`, target);
        }
      }

      if (typeof value === "number" && Number.isFinite(value)) {
        const numericBounds = [
          ["minimum", (bound: number) => value >= bound],
          ["maximum", (bound: number) => value <= bound],
          ["exclusiveMinimum", (bound: number) => value > bound],
          ["exclusiveMaximum", (bound: number) => value < bound],
        ] as const;
        for (const [keyword, matches] of numericBounds) {
          const bound = candidate[keyword];
          if (bound !== undefined && (typeof bound !== "number" || !Number.isFinite(bound))) {
            add(path, pointer(schemaPath, keyword), keyword, `${keyword} must be a finite number`, target);
          } else if (typeof bound === "number" && !matches(bound)) {
            add(path, pointer(schemaPath, keyword), keyword, `Number does not satisfy ${keyword} ${bound}`, target);
          }
        }
        if (candidate.multipleOf !== undefined) {
          if (typeof candidate.multipleOf !== "number" || candidate.multipleOf <= 0) {
            add(path, pointer(schemaPath, "multipleOf"), "multipleOf", "multipleOf must be greater than zero", target);
          } else {
            const quotient = value / candidate.multipleOf;
            if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * 10) {
              add(path, pointer(schemaPath, "multipleOf"), "multipleOf", `Number is not a multiple of ${candidate.multipleOf}`, target);
            }
          }
        }
      }
    };

    validateShape(schema, "", 0);
    if (!diagnostics.length) visit(schema, data, "", "", 0);
    const unique = new Map<string, ArtifactDataDiagnostic>();
    for (const diagnostic of diagnostics) {
      unique.set(
        `${diagnostic.path}:${diagnostic.schemaPath}:${diagnostic.keyword}:${diagnostic.message}`,
        diagnostic,
      );
    }
    const bounded = Array.from(unique.values()).slice(0, MAX_DIAGNOSTICS);
    return bounded.length ? { ok: false, diagnostics: bounded } : { ok: true };
  }
}
