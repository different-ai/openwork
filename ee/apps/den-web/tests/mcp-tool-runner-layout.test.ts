import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"

const runnerPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/mcp-tool-runner.tsx", import.meta.url),
)

describe("MCP tool runner layout", () => {
  test("keeps the refresh action on one line", () => {
    const runner = readFileSync(runnerPath, "utf8")

    expect(runner).toContain('className="shrink-0 whitespace-nowrap"')
    expect(runner).toContain("Refresh tools")
  })
})
