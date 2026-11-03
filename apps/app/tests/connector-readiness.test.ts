import { describe, expect, test } from "bun:test"
import type { DenExternalMcpConnection } from "../src/app/lib/den"
import { recordedConnectorNote, recordedConnectorState } from "../src/react-app/domains/settings/connector-readiness"

const checkedAt = "2026-10-22T12:00:00.000Z"
type Readiness = NonNullable<DenExternalMcpConnection["readiness"]>
const ready: Readiness = { status: "ready", checkedAt, lastSuccessfulAt: checkedAt, reason: null, failure: null }
const down: Readiness = { status: "could_not_verify", checkedAt, lastSuccessfulAt: null, reason: "The service didn't respond. Try again later.", failure: "unavailable" }

function connection(overrides: Partial<DenExternalMcpConnection> = {}): DenExternalMcpConnection {
  return {
    id: "emc_1", name: "Notes", url: "https://notes.example.test/mcp", authType: "apikey", credentialMode: "shared",
    exposeDirectly: false, connected: true, connectedAt: checkedAt, connectedForMe: true, readiness: null, ...overrides,
  }
}

describe("Library connector status (ENG-866)", () => {
  test("never checked reads as Not checked, never as a failed check", () => {
    expect(recordedConnectorState(connection())).toBe("Not checked")
    expect(recordedConnectorNote(connection())).toBe("Not checked yet.")
  })

  test("checking, verified, failed and sign-in-required are distinct", () => {
    expect(recordedConnectorState(connection(), { checking: true })).toBe("Checking…")
    expect(recordedConnectorState(connection({ readiness: ready }))).toBe("Ready")
    expect(recordedConnectorState(connection({ readiness: down }))).toBe("Couldn't verify")
    expect(recordedConnectorNote(connection({ readiness: down }))).toBe(down.reason ?? "")
    expect(recordedConnectorState(connection({ readiness: { ...down, failure: "sign_in_rejected" } }))).toBe("Sign in")
    expect(recordedConnectorState(connection({ readiness: { ...down, failure: "timed_out" } }))).toBe("Couldn't verify")
  })

  test("a member not signed in to a per-member connection is asked to sign in, not told it failed", () => {
    const personal = connection({ credentialMode: "per_member", connectedForMe: false })
    expect(recordedConnectorState(personal)).toBe("Sign in")
    expect(recordedConnectorNote(personal)).toBe("Sign in to use and check this connection.")
  })
})
