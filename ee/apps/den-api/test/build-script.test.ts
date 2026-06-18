import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { createPackageManagerSpawnInput, createPnpmSpawnInput } from "../scripts/build.mjs"
import { BUILD_LATEST_APP_VERSION } from "../src/generated/app-version"

describe("den-api build script", () => {
  test("quotes the pnpm command when Windows shell mode is required", () => {
    const input = createPnpmSpawnInput("C:\\Program Files\\pnpm (den)\\pnpm.cmd", ["exec", "tsc", "-p", "tsconfig.json"], "win32")

    expect(input).toEqual({
      command: '"C:\\Program Files\\pnpm (den)\\pnpm.cmd" "exec" "tsc" "-p" "tsconfig.json"',
      args: [],
      shell: true,
    })
  })

  test("keeps direct argv spawning on non-Windows platforms", () => {
    const args = ["exec", "tsc", "-p", "tsconfig.json"]
    const input = createPnpmSpawnInput("pnpm", args, "linux")

    expect(input).toEqual({
      command: "pnpm",
      args,
      shell: false,
    })
  })

  test("reuses pnpm's npm_execpath instead of resolving nested Windows shims", () => {
    const input = createPackageManagerSpawnInput(["run", "build:email"], {
      nodeCommand: "C:\\Program Files\\nodejs\\node.exe",
      npmExecPath: "C:\\Users\\dev\\AppData\\Local\\pnpm\\pnpm.cjs",
      npmExecPathExists: true,
      platform: "win32",
    })

    expect(input).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\Users\\dev\\AppData\\Local\\pnpm\\pnpm.cjs", "run", "build:email"],
      shell: false,
    })
  })

  test("keeps generated latest app version in sync with desktop package", () => {
    const packageJson = JSON.parse(readFileSync(path.resolve(import.meta.dir, "../../../../apps/desktop/package.json"), "utf8"))

    expect(BUILD_LATEST_APP_VERSION).toBe(packageJson.version)
  })
})
