import { describe, expect, test } from "bun:test"
import { createPnpmSpawnInput } from "../scripts/build.mjs"

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
})
