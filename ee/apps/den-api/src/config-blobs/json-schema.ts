import {
  CONFIG_BLOB_FORMAT_VERSION,
  configBlobItemSchema,
  configBlobSchema,
} from "@openwork/types/den/config-blobs"
import { z } from "zod"
import { env } from "../env.js"
import type { ConfigArea } from "./area.js"
import { CONFIG_AREAS } from "./registry.js"

export const CONFIG_BLOB_SCHEMA_PATH = "/v1/config-blobs/schema"

type JsonSchema = { [key: string]: unknown }

export function configBlobSchemaUrl(formatVersion: number = CONFIG_BLOB_FORMAT_VERSION): string | null {
  const base = env.apiPublicUrl?.replace(/\/+$/, "")
  return base ? `${base}${CONFIG_BLOB_SCHEMA_PATH}/${formatVersion}` : null
}

function toJsonSchema(schema: z.ZodType): JsonSchema {
  const generated: JsonSchema = { ...z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) }
  delete generated.$schema
  return generated
}

function areaSchema(area: ConfigArea, itemBase: JsonSchema): JsonSchema {
  const itemProperties = typeof itemBase.properties === "object" && itemBase.properties !== null ? itemBase.properties : {}
  return {
    type: "object",
    title: area.path.join(" › "),
    description: `Area \`${area.key}\` (spec version ${area.specVersion}).${area.secretFields.length > 0 ? ` Secret fields (\`$secret\` placeholders): ${area.secretFields.join(", ")}.` : ""}`,
    additionalProperties: false,
    required: ["specVersion", "items"],
    properties: {
      specVersion: { type: "integer", minimum: 1, description: `Spec version of this area's items. This server writes ${area.specVersion}; older versions are upgraded on import.` },
      items: {
        type: "array",
        items: { ...itemBase, properties: { ...itemProperties, spec: toJsonSchema(area.specSchema) } },
      },
    },
  }
}

type AreasNode = { leaf: JsonSchema | null; children: Map<string, AreasNode> }

function areasTreeSchema(itemBase: JsonSchema): JsonSchema {
  const root: AreasNode = { leaf: null, children: new Map() }
  for (const area of CONFIG_AREAS) {
    let node = root
    for (const segment of area.key.split(".")) {
      let child = node.children.get(segment)
      if (!child) {
        child = { leaf: null, children: new Map() }
        node.children.set(segment, child)
      }
      node = child
    }
    node.leaf = areaSchema(area, itemBase)
  }
  const render = (node: AreasNode): JsonSchema => node.leaf ?? {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries([...node.children].map(([segment, child]) => [segment, render(child)])),
  }
  return render(root)
}

const cache = new Map<number, JsonSchema>()

export function configBlobJsonSchema(formatVersion: number): JsonSchema | null {
  if (formatVersion !== CONFIG_BLOB_FORMAT_VERSION) return null
  const cached = cache.get(formatVersion)
  if (cached) return cached
  const envelope = toJsonSchema(configBlobSchema)
  const envelopeProperties = typeof envelope.properties === "object" && envelope.properties !== null ? envelope.properties : {}
  const url = configBlobSchemaUrl(formatVersion)
  const schema: JsonSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...(url ? { $id: url } : {}),
    title: "OpenWork config blob",
    description: "An OpenWork organization configuration export (openwork.config-blob). Secrets never appear: secret fields are `$secret` placeholders; references to other items are `$ref` objects.",
    ...envelope,
    properties: { ...envelopeProperties, areas: areasTreeSchema(toJsonSchema(configBlobItemSchema)) },
  }
  cache.set(formatVersion, schema)
  return schema
}
