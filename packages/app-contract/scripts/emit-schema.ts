import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { z } from "zod"

import { appManifestSchema, MANIFEST_VERSION } from "../src/manifest.js"
import { stringifyJsonCanonical } from "../src/json.js"
import { packageMetadataSchema } from "../src/package.js"

// The published JSON Schema is generated from the same Zod schema the host and
// CLI validate with. Nothing is hand-written, so the schema cannot drift away
// from the validator — the failure mode where an author's editor says a
// manifest is fine and the installer disagrees.

const here = dirname(fileURLToPath(import.meta.url))
const outputDir = join(here, "..", "schema")

const targets = [
  {
    file: "openwork.app.schema.json",
    id: `https://openwork.dev/schema/openwork.app.v${MANIFEST_VERSION}.json`,
    title: "OpenWork App manifest",
    description: "Root openwork.app.json manifest for an OpenWork App.",
    schema: appManifestSchema,
  },
  {
    file: "openwork-package.schema.json",
    id: "https://openwork.dev/schema/openwork-package.v1.json",
    title: "OpenWork App package metadata",
    description: "META-INF/openwork-package.json inside a .owapp archive.",
    schema: packageMetadataSchema,
  },
] as const

await mkdir(outputDir, { recursive: true })

for (const target of targets) {
  const generated = z.toJSONSchema(target.schema, { target: "draft-2020-12", io: "input" })
  const document = {
    ...generated,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: target.id,
    title: target.title,
    description: target.description,
  }
  const path = join(outputDir, target.file)
  await writeFile(path, stringifyJsonCanonical(document), "utf8")
  process.stdout.write(`wrote ${path}\n`)
}
