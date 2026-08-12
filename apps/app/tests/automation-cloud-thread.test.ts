import { describe, expect, test } from "bun:test"
import type { AutomationExecutionThread } from "@openwork/types/automations"
import {
  automationExecutionThreadRoute,
  automationExecutionIdentity,
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
})
