import { describe, expect, test } from "bun:test"
import type { AutomationExecutionThread } from "@openwork/types/automations"
import {
  automationExecutionThreadRoute,
  automationExecutionIdentity,
  automationLocalSessionRoute,
} from "../src/react-app/domains/automations/automation-cloud-thread"

function desktopThread(engineKind: string): AutomationExecutionThread {
  return {
    id: "ath_test",
    threadKind: "automation",
    executionLocation: "desktop",
    automationId: "aut_test",
    automationRunId: "arun_test",
    engineKind,
  }
}

function cloudThread(): AutomationExecutionThread {
  return { ...desktopThread("openwork-cloud-agent-v1"), executionLocation: "cloud" }
}

describe("Automation execution thread UI", () => {
  test("uses Den's persisted thread identity for receipt navigation", () => {
    expect(automationExecutionThreadRoute(desktopThread("openwork-desktop-runner-v1"))).toBe(
      "/automations?automation=aut_test&run=arun_test&thread=ath_test",
    )
  })

  test("labels a desktop-targeted run from its persisted execution location", () => {
    expect(automationExecutionIdentity(desktopThread("future-replaceable-engine"))).toEqual({
      icon: "desktop",
      label: "Desktop",
    })
  })

  test("labels a Web-created run as OpenWork Cloud on Desktop", () => {
    expect(automationExecutionIdentity(cloudThread())).toEqual({
      icon: "cloud",
      label: "OpenWork Cloud",
    })
  })

  test("opens a linked Desktop run in its native local session", () => {
    expect(automationLocalSessionRoute({
      ...desktopThread("openwork-desktop-runner-v1"),
      workspaceId: "ws with spaces",
      nativeThreadId: "ses/failed",
    })).toBe("/workspace/ws%20with%20spaces/session/ses%2Ffailed")
    expect(automationLocalSessionRoute(desktopThread("openwork-desktop-runner-v1"))).toBeNull()
    expect(automationLocalSessionRoute({
      ...cloudThread(),
      workspaceId: "ws_cloud",
      nativeThreadId: "ses_cloud",
    })).toBeNull()
  })
})
