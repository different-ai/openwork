import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

const [outArg, varsArg] = process.argv.slice(2)
if (!outArg || !varsArg) throw new Error("usage: celld-bundle.ts <out dir> <vars.json>")
const out = resolve(outArg)
const project = join(dirname(fileURLToPath(import.meta.url)), "..")
const vars = z.record(z.string(), z.string()).parse(JSON.parse(readFileSync(resolve(varsArg), "utf8")))
if (vars.HEADLESS_FILES !== "s3" && vars.HEADLESS_FILES !== "off") throw new Error("cells need HEADLESS_FILES=s3 or off")

mkdirSync(out, { recursive: true })
execFileSync(
  join(project, "node_modules/.bin/esbuild"),
  [
    join(project, "src/worker/index.ts"),
    "--bundle",
    "--platform=neutral",
    "--conditions=workerd,browser",
    "--main-fields=browser,module,main",
    "--format=esm",
    "--external:node:*",
    "--external:cloudflare:*",
    ...builtinModules.filter((name) => !name.startsWith("node:")).map((name) => `--alias:${name}=node:${name}`),
    `--outfile=${join(out, "index.js")}`,
    "--log-level=warning",
  ],
  { cwd: project, stdio: "inherit" },
)

const source = readFileSync(join(project, "wrangler.jsonc"), "utf8")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n")
const config = z.object({ name: z.string(), main: z.string() }).passthrough().parse(JSON.parse(source))
writeFileSync(join(out, "wrangler.json"), JSON.stringify({ ...config, main: "index.js", vars }), { mode: 0o600 })
console.log(`bundled ${config.name} into ${out} with ${Object.keys(vars).length} settings`)
