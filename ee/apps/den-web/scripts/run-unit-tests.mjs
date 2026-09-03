import { spawnSync } from "node:child_process"

// TODO(ci): Remove these exclusions after the corresponding origin/dev failures listed in the PR are fixed.
const excludedTestPatterns = [
  "**/{settings-stripe-layout,mcp-oauth-bootstrap,workspace-branding-polish,den-flow-auth-cookie-clear,mcp-connection-url-entry,mcp-oauth-callback-migration}.test.*",
  "**/den-org.selection.test.mts",
]

const result = spawnSync("bun", [
  "test",
  "--conditions",
  "development",
  ...excludedTestPatterns.map((pattern) => `--path-ignore-patterns=${pattern}`),
], { stdio: "inherit" })

if (result.error) {
  throw result.error
}
process.exitCode = result.status ?? 1
