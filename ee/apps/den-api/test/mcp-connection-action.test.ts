import { expect, test } from "bun:test"
import {
  connectedConnectionActionPayload,
  connectionActionSearchCard,
  connectionActionPayloadFromStatus,
  connectionActionPayloadSchema,
  connectionActionTextFallback,
} from "../src/mcp/connection-action.js"
import type { ExternalConnectionStatus } from "../src/mcp/external-capabilities.js"

const needsSignInStatus: ExternalConnectionStatus = {
  version: 1,
  kind: "connection_action",
  source: "openwork-cloud",
  layer: "downstream_provider",
  connectionId: "emc_gmail",
  connectionName: "Gmail",
  authType: "oauth",
  credentialMode: "per_member",
  state: "needs_connection",
  errorCode: "not_connected",
  message: "You haven't connected your Gmail account yet.",
  actor: "member",
  action: {
    type: "connect",
    label: "Connect Gmail",
    surface: "openwork_your_connections",
    retry: "search_capabilities",
    url: "https://app.openworklabs.com/dashboard/connections/emc_gmail",
  },
}

test("connection status payloads carry the exact human action for native rendering", () => {
  const payload = connectionActionPayloadFromStatus(needsSignInStatus)
  expect(connectionActionPayloadSchema.parse(payload)).toEqual({
    schemaVersion: "1",
    connectionId: "emc_gmail",
    connectionName: "Gmail",
    state: "needs_connection",
    actor: "member",
    message: "You haven't connected your Gmail account yet.",
    action: {
      type: "connect",
      label: "Connect Gmail",
      surface: "openwork_your_connections",
      url: "https://app.openworklabs.com/dashboard/connections/emc_gmail",
    },
  })
  const match = { kind: "connection_status", connectionStatus: needsSignInStatus }
  const searchCard = connectionActionSearchCard([match])
  expect(searchCard).toEqual(payload)
  expect(connectionActionSearchCard([match, match])).toEqual(searchCard)
  expect(connectionActionSearchCard([])).toBeNull()
  expect(connectionActionSearchCard([{ kind: "tool" }])).toBeNull()
  expect(connectionActionSearchCard([match, {
    ...match, connectionStatus: { ...needsSignInStatus, connectionId: "emc_other" },
  }])).toBeNull()
  const fallback = connectionActionTextFallback(payload)
  expect(fallback).toContain("# Connection needs attention: Gmail")
  expect(fallback).toContain("Action: Connect Gmail")
  expect(fallback).toContain("Open: https://app.openworklabs.com/dashboard/connections/emc_gmail")

  const connected = connectedConnectionActionPayload({ connectionId: "emc_gmail", connectionName: "Gmail" })
  expect(connected.state).toBe("connected")
  expect(connected.action).toBeNull()
  expect(connectionActionTextFallback(connected)).toContain("# Connection ready: Gmail")
})
