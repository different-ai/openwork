import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { SERVICES, checkService, formatProblems } from "./check-node-source-imports.mjs"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const ts = createRequire(path.join(repoRoot, "package.json"))("typescript")

/**
 * One source-served export per case, each imported at runtime by the service.
 * `loads` is what production Node does with it; the parity test below checks
 * that against a real Node process, so the static check cannot drift from Node.
 */
const CASES = {
  "ok-by-package-name": { loads: true, source: 'import { value } from "@fx/lib/values"\nexport const out = value\n' },
  "ok-real-file-name": { loads: true, source: 'import { value } from "./values.ts"\nexport const out = value\n' },
  "ok-type-import-of-missing-file": { loads: true, source: 'import type { Shape } from "./nowhere"\nexport const out: Shape = 1\n' },
  "ok-value-that-is-also-a-type": { loads: true, source: 'import { Both } from "./values.ts"\nexport const out: Both = Both\n' },
  "ok-marked-type": { loads: true, source: 'import { value, type Shape } from "./values.ts"\nexport const out: Shape = { size: value }\n' },
  "ok-namespace-of-types": { loads: true, source: "export namespace Names { export type Id = string }\nexport const out = 1\n" },
  "bad-no-extension": { loads: false, message: /imports "\.\/values", which Node cannot resolve\. Import it by package name: "@fx\/lib\/values"\./, source: 'import { value } from "./values"\nexport const out = value\n' },
  "bad-js-extension": { loads: false, message: /imports "\.\/values\.js", which Node cannot resolve/, source: 'import { value } from "./values.js"\nexport const out = value\n' },
  "bad-unexported-sibling": { loads: false, message: /Import it by its real file name \("\.\/private\.ts"\)/, source: 'import { hidden } from "./private"\nexport const out = hidden\n' },
  "bad-directory": { loads: false, message: /imports "\.\/folder", which Node cannot resolve/, source: 'import { inner } from "./folder"\nexport const out = inner\n' },
  "bad-inline-types-only": { loads: false, message: /imports "\.\/values", which Node cannot resolve/, source: 'import { type Shape } from "./values"\nexport const out: Shape = { size: 1 }\n' },
  "bad-type-without-type": { loads: false, message: /imports `Shape` from "\.\/values\.ts" without `type`/, source: 'import { Shape } from "./values.ts"\nexport const out: Shape = { size: 1 }\n' },
  "bad-type-reexport": { loads: false, message: /imports `Shape` from "\.\/values\.ts" without `type`/, source: 'export { Shape } from "./values.ts"\n' },
  "bad-enum": { loads: false, message: /uses an enum/, source: "export enum Level { low, high }\n" },
  "bad-namespace": { loads: false, message: /uses a namespace with values/, source: "export namespace Names { export const first = 1 }\n" },
  "bad-parameter-property": { loads: false, message: /uses a constructor parameter property/, source: "export class Box { constructor(private size: number) {} }\n" },
  "bad-through-another-export": { loads: false, message: /bad-no-extension\.ts:1 imports "\.\/values"/, source: 'export { out } from "@fx/lib/bad-no-extension"\n' },
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "node-source-imports-"))
  const lib = path.join(root, "packages", "lib")
  const service = path.join(root, "ee", "apps", "service")
  mkdirSync(path.join(lib, "src", "folder"), { recursive: true })
  mkdirSync(path.join(lib, "dist"), { recursive: true })
  mkdirSync(path.join(service, "src"), { recursive: true })
  // Linked the way pnpm links workspace packages (Node refuses to strip types under a real node_modules path).
  mkdirSync(path.join(service, "node_modules", "@fx"), { recursive: true })
  symlinkSync(lib, path.join(service, "node_modules", "@fx", "lib"), "dir")

  const sourceExport = (file) => ({ development: file, default: file })
  writeFileSync(path.join(lib, "package.json"), JSON.stringify({
    name: "@fx/lib",
    type: "module",
    exports: {
      "./values": sourceExport("./src/values.ts"),
      ...Object.fromEntries(Object.keys(CASES).map((name) => [`./${name}`, sourceExport(`./src/${name}.ts`)])),
      "./bad-component": sourceExport("./src/bad-component.tsx"),
      // Broken source that production never loads: the bundle is served instead.
      "./built": { development: "./src/bad-no-extension.ts", default: "./dist/built.js" },
      "./types-only": sourceExport("./src/bad-enum.ts"),
    },
  }))
  writeFileSync(path.join(lib, "src", "values.ts"), "export const value = 1\nexport interface Shape { size: number }\nexport const Both = 2\nexport type Both = number\n")
  writeFileSync(path.join(lib, "src", "private.ts"), "export const hidden = 1\n")
  writeFileSync(path.join(lib, "src", "folder", "index.ts"), "export const inner = 1\n")
  writeFileSync(path.join(lib, "src", "bad-component.tsx"), "export const out = 1\n")
  writeFileSync(path.join(lib, "dist", "built.js"), "export const out = 1\n")
  for (const [name, entry] of Object.entries(CASES)) writeFileSync(path.join(lib, "src", `${name}.ts`), entry.source)

  writeFileSync(path.join(service, "package.json"), JSON.stringify({ name: "@fx/service", type: "module", dependencies: { "@fx/lib": "workspace:*" } }))
  writeFileSync(path.join(service, "src", "main.ts"), [
    ...Object.keys(CASES).map((name, index) => `export * as case${index} from "@fx/lib/${name}"`),
    'export { out as built } from "@fx/lib/built"',
    // Erased by the compiler: neither reaches the running service.
    'import type { Level } from "@fx/lib/types-only"',
    'import { Level as Other } from "@fx/lib/types-only"',
    "export const level: Level | Other | undefined = undefined",
    'export const lazy = () => import("@fx/lib/bad-component")',
    "",
  ].join("\n"))
  writeFileSync(path.join(service, "src", "main.test.ts"), 'import { Level } from "@fx/lib/types-only"\nexport const level = Level.low\n')
  return { root, service }
}

function withFixture(run) {
  const { root, service } = fixture()
  try {
    return run({ root, service, result: checkService("ee/apps/service", { root, ts }) })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const reachedThrough = (result, name) => result.problems.filter((problem) => problem.via.startsWith(`@fx/lib/${name} `))

test("every import a service keeps at runtime is checked, and nothing the compiler erases", () => {
  withFixture(({ result }) => {
    assert.deepEqual(result.entries, [...Object.keys(CASES).map((name) => `@fx/lib/${name}`), "@fx/lib/bad-component"].sort())
  })
})

for (const [name, entry] of Object.entries(CASES)) {
  test(`${name}: ${entry.loads ? "passes" : "is reported with how to fix it"}`, () => {
    withFixture(({ result }) => {
      const problems = reachedThrough(result, name)
      if (entry.loads) return assert.deepEqual(problems, [])
      assert.equal(problems.length, 1, JSON.stringify(problems))
      assert.match(`${problems[0].file}:${problems[0].line} ${problems[0].message}`, entry.message)
    })
  })
}

test("a .tsx export loaded at runtime is reported; an export served from dist is not, whatever its source does", () => {
  withFixture(({ result }) => {
    assert.match(reachedThrough(result, "bad-component")[0]?.message ?? "", /is a \.tsx file/)
    assert.deepEqual(reachedThrough(result, "built"), [])
  })
})

test("the report names the file, the fix and the service that loads it", () => {
  withFixture(({ result }) => {
    const report = formatProblems([{ ...result, problems: reachedThrough(result, "bad-no-extension") }])
    assert.match(report, /- packages\/lib\/src\/bad-no-extension\.ts:1 imports "\.\/values", which Node cannot resolve\. Import it by package name: "@fx\/lib\/values"\./)
    assert.match(report, /Loaded in production by ee\/apps\/service through @fx\/lib\/bad-no-extension \(imported by ee\/apps\/service\/src\/main\.ts\)\./)
  })
})

test("the check agrees with a real Node process on every case", () => {
  withFixture(({ service, result }) => {
    for (const [name, entry] of Object.entries({ ...CASES, "bad-component": { loads: false } })) {
      const loaded = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(`@fx/lib/${name}`)})`], {
        cwd: service,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
      })
      assert.equal(loaded.status === 0, entry.loads, `${name}: Node ${loaded.status === 0 ? "loaded it" : `failed: ${loaded.stderr}`}`)
      assert.equal(reachedThrough(result, name).length === 0, entry.loads, `${name}: the check disagrees with Node`)
    }
  })
})

test("the listed services exist", () => {
  for (const service of SERVICES) assert.doesNotThrow(() => checkService(service, { ts, packages: new Map() }), service)
})
