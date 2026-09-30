import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { missingProductionWorkspaceTypes } from "../scripts/build.mjs"

const serviceDir = path.resolve(fileURLToPath(new URL("../", import.meta.url)))
const fixtureFile = path.join(serviceDir, "test/fixtures/production-types.ts")

function fixturePackage(run: (root: string, dependencyDir: string) => void) {
  const root = mkdtempSync(path.join(tmpdir(), "den-api-type-exports-"))
  const dependencyDir = path.join(root, "node_modules", "@fixture", "library")
  mkdirSync(dependencyDir, { recursive: true })
  writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "fixture-service", dependencies: { "@fixture/library": "workspace:*" },
  }))
  try {
    run(root, dependencyDir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("production type boundaries", () => {
  test("missing declarations cannot silently fall back to shared source", () => {
    fixturePackage((root, dependencyDir) => {
      writeFileSync(path.join(dependencyDir, "package.json"), JSON.stringify({
        name: "@fixture/library",
        exports: { ".": { types: { "openwork-build": "./dist/index.d.ts", default: "./src/index.ts" } } },
      }))
      mkdirSync(path.join(dependencyDir, "src"))
      writeFileSync(path.join(dependencyDir, "src/index.ts"), "export type Value = string\n")
      expect(missingProductionWorkspaceTypes(root)).toEqual(["@fixture/library: ./dist/index.d.ts"])
      mkdirSync(path.join(dependencyDir, "dist"))
      writeFileSync(path.join(dependencyDir, "dist/index.d.ts"), "export type Value = string\n")
      expect(missingProductionWorkspaceTypes(root)).toEqual([])
    })
  })

  test("a new source-only workspace dependency must declare its build boundary", () => {
    fixturePackage((root, dependencyDir) => {
      writeFileSync(path.join(dependencyDir, "package.json"), JSON.stringify({
        name: "@fixture/library", exports: {
          ".": { types: "./src/index.ts" },
          "./source-only": "./src/extra.ts",
        },
      }))
      expect(missingProductionWorkspaceTypes(root)).toEqual([
        "@fixture/library/source-only: missing openwork-build declaration export",
        "@fixture/library: missing openwork-build declaration export",
      ])
    })
  })

  test("every shared public type export was built", () => {
    expect(missingProductionWorkspaceTypes(serviceDir)).toEqual([])
  })

  test("database selection and schema inference stay precise without shared implementations", () => {
    const config = ts.readConfigFile(path.join(serviceDir, "tsconfig.build.json"), ts.sys.readFile)
    expect(config.error).toBeUndefined()
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, serviceDir)
    const program = ts.createProgram([fixtureFile], { ...parsed.options, rootDir: serviceDir, noEmit: true })
    const diagnostics = ts.getPreEmitDiagnostics(program)
    expect(diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n"))).toEqual([])
    const sharedImplementations = program.getSourceFiles().filter((file) =>
      !file.isDeclarationFile && !file.fileName.startsWith(`${serviceDir}${path.sep}`),
    )
    expect(sharedImplementations.map((file) => file.fileName)).toEqual([])
  })

  test("development resolves the source while production resolves declarations", () => {
    const options = { moduleResolution: ts.ModuleResolutionKind.Bundler }
    const source = ts.resolveModuleName("@openwork-ee/den-db", fixtureFile, options, ts.sys).resolvedModule
    const built = ts.resolveModuleName("@openwork-ee/den-db", fixtureFile, {
      ...options, customConditions: ["openwork-build"],
    }, ts.sys).resolvedModule
    expect(source?.resolvedFileName.endsWith("/src/index.ts")).toBe(true)
    expect(built?.resolvedFileName.endsWith("/dist/types/src/index.d.ts")).toBe(true)
  })
})
