import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { DenExternalMcpConnection } from "../src/app/lib/den"
import {
  connectionIdsUsedByApp,
  McpAppSignInPrompts,
  signInPromptFromToolResult,
  signInPromptsForConnections,
} from "../src/components/chat/mcp-app-sign-in"

const launch = {
  content: [{ type: "text", text: "Inventory board" }],
  structuredContent: {
    app: {
      appId: "cob_app", title: "Inventory board",
      tools: [
        { name: "list_issues", capability: "mcp:emc_linear:list_issues" },
        { name: "create_issue", capability: "mcp:emc_linear:create_issue" },
        { name: "lookup_price", capability: "mcp:emc_inventory:lookup_price" },
        { name: "weekly_report", capability: "marketplace:plg_1:cob_workflow" },
      ],
    },
    input: {},
  },
}

function connection(overrides: Partial<DenExternalMcpConnection>): DenExternalMcpConnection {
  return {
    id: "emc_linear", name: "Linear", url: "https://mcp.linear.app/mcp", authType: "oauth", credentialMode: "per_member",
    exposeDirectly: false, connected: true, connectedAt: "2026-10-01T00:00:00.000Z", connectedForMe: false,
    ...overrides,
  }
}

const needsSignIn = {
  schemaVersion: "1" as const, connectionId: "emc_linear", connectionName: "Linear", state: "needs_connection" as const, actor: "member" as const,
  message: "You haven't connected your Linear account yet.",
  action: { type: "connect" as const, label: "Connect Linear", surface: "openwork_your_connections" as const },
}

test("reads each connection an App's tools use once, ignoring Workflows", () => {
  expect(connectionIdsUsedByApp(launch)).toEqual(["emc_linear", "emc_inventory"])
  expect(connectionIdsUsedByApp({ structuredContent: { artifact: {} } })).toEqual([])
  expect(connectionIdsUsedByApp(null)).toEqual([])
})

test("asks the viewer to sign in only where they have not, and names the admin for shared setup", () => {
  const prompts = signInPromptsForConnections(["emc_linear", "emc_inventory", "emc_hidden"], [
    connection({}),
    connection({ id: "emc_inventory", name: "Inventory", authType: "none", credentialMode: "shared", connectedForMe: true }),
  ])
  expect(prompts).toEqual([{ ...needsSignIn, action: { ...needsSignIn.action, label: "Sign in" } }])

  expect(signInPromptsForConnections(["emc_linear"], [connection({ connectedForMe: true })])).toEqual([])
  expect(signInPromptsForConnections(["emc_linear"], [connection({ connectedForMe: true, needsReconnect: true, reconnectActionOwner: "member" })]))
    .toMatchObject([{ state: "reauth_required", actor: "member", action: { type: "reconnect" } }])
  expect(signInPromptsForConnections(["emc_linear"], [connection({ credentialMode: "shared", connected: false })]))
    .toMatchObject([{ state: "needs_connection", actor: "organization_admin", action: null }])
  expect(signInPromptsForConnections(["emc_linear"], [connection({ issuerReviewRequired: true })]))
    .toMatchObject([{ actor: "organization_admin", action: null }])
})

test("a bound tool's sign-in failure becomes a prompt; other results do not", () => {
  expect(signInPromptFromToolResult({ isError: true, structuredContent: needsSignIn })).toEqual(needsSignIn)
  expect(signInPromptFromToolResult({ isError: false, structuredContent: needsSignIn })).toBeNull()
  expect(signInPromptFromToolResult({ isError: true, structuredContent: { ...needsSignIn, state: "provider_error" } })).toBeNull()
  expect(signInPromptFromToolResult({ isError: true, structuredContent: { rows: [] } })).toBeNull()
})

test("the prompt names the connection and the App, with one sign-in action", () => {
  const html = renderToStaticMarkup(<McpAppSignInPrompts prompts={[needsSignIn]} appTitle="Inventory board" scope="ui://app" onSignedIn={() => {}} />)
  expect(html).toContain("Sign in to Linear to use Inventory board")
  expect(html).toContain(">Sign in</button>")
  expect(html.match(/<button/g)?.length).toBe(1)

  const again = renderToStaticMarkup(<McpAppSignInPrompts appTitle="Inventory board" scope="ui://app" onSignedIn={() => {}}
    prompts={[{ ...needsSignIn, state: "reauth_required", action: { ...needsSignIn.action, type: "reconnect" } }]} />)
  expect(again).toContain("Sign in to Linear again to use Inventory board")
  expect(again).toContain(">Sign in again</button>")

  const blocked = renderToStaticMarkup(<McpAppSignInPrompts appTitle="Inventory board" scope="ui://app" onSignedIn={() => {}}
    prompts={[{ ...needsSignIn, actor: "organization_admin", action: null }]} />)
  expect(blocked).toContain("Your organization admin must configure Linear")
  expect(blocked).not.toContain(">Sign in</button>")

  expect(renderToStaticMarkup(<McpAppSignInPrompts prompts={[]} appTitle={null} scope="ui://app" onSignedIn={() => {}} />)).toBe("")
})
