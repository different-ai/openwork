import { MODULE_IDS } from "@openwork/license-contracts/modules"
import { describe, expect, test } from "vitest"
import { AVAILABILITY_PROBES, computeInstanceAvailability, UnknownInfrastructureError, unavailableModules } from "./instance/availability"
import { describeDeployment, parseInstanceConfig, resolveDeployment } from "./instance/config"
import { testInstanceConfig } from "./testing"

describe("parseInstanceConfig", () => {
  test("empty env gives den-api's defaults", () => {
    expect(parseInstanceConfig({})).toEqual({
      orgMode: "single_org",
      infra: { gatewayEnabled: false, workbotConfigured: false, freeInferenceConfigured: false },
      deprecatedFlags: {
        planGatingEnabled: false,
        automationsRuntimeEnabled: true,
        automationsDesktopEnabled: false,
        appMcpServersEnabled: true,
        dashboardsDesktopEnabled: false,
        openworkWebEnabled: false,
        auditCaptureEnabled: true,
        auditVisibilityEnabled: true,
        auditSelfHostedEnabled: false,
        slackAssistantWorkerEnabled: true,
      },
    })
  })

  test.each([
    ["DEN_APP_MCP_SERVERS_ENABLED", "", true],
    ["DEN_APP_MCP_SERVERS_ENABLED", "  ", true],
    ["DEN_APP_MCP_SERVERS_ENABLED", "off", false],
    ["DEN_APP_MCP_SERVERS_ENABLED", "garbage", false],
    ["DEN_APP_MCP_SERVERS_ENABLED", "YES", true],
  ])("%s=%j → appMcpServersEnabled %s (I5)", (name, value, expected) => {
    expect(parseInstanceConfig({ [name]: value }).deprecatedFlags.appMcpServersEnabled).toBe(expected)
  })

  test("automations runtime defaults from the desktop flag, and a disabled runtime forces the desktop flag off (I6)", () => {
    expect(parseInstanceConfig({ DEN_AUTOMATIONS_ENABLED: "false" }).deprecatedFlags).toMatchObject({ automationsRuntimeEnabled: false, automationsDesktopEnabled: false })
    expect(parseInstanceConfig({ DEN_AUTOMATIONS_ENABLED: "true" }).deprecatedFlags).toMatchObject({ automationsRuntimeEnabled: true, automationsDesktopEnabled: true })
    expect(parseInstanceConfig({ DEN_AUTOMATIONS_ENABLED: "true", DEN_AUTOMATIONS_RUNTIME_ENABLED: "0" }).deprecatedFlags)
      .toMatchObject({ automationsRuntimeEnabled: false, automationsDesktopEnabled: false })
    expect(parseInstanceConfig({ DEN_AUTOMATIONS_RUNTIME_ENABLED: "on" }).deprecatedFlags.automationsRuntimeEnabled).toBe(true)
  })

  test("plan gating accepts only true (case-insensitive)", () => {
    expect(parseInstanceConfig({ DEN_PLAN_GATING_ENABLED: "TRUE" }).deprecatedFlags.planGatingEnabled).toBe(true)
    expect(parseInstanceConfig({ DEN_PLAN_GATING_ENABLED: "1" }).deprecatedFlags.planGatingEnabled).toBe(false)
  })

  test("audit flags accept only the literal strings, like den-api's zod enum", () => {
    expect(parseInstanceConfig({ DEN_AUDIT_CAPTURE_ENABLED: "false", DEN_AUDIT_SELF_HOSTED_ENABLED: "true" }).deprecatedFlags)
      .toMatchObject({ auditCaptureEnabled: false, auditSelfHostedEnabled: true, auditVisibilityEnabled: true })
    expect(() => parseInstanceConfig({ DEN_AUDIT_VISIBILITY_ENABLED: "1" })).toThrow("DEN_AUDIT_VISIBILITY_ENABLED")
  })

  test("infrastructure inputs follow the apps' parsers", () => {
    expect(parseInstanceConfig({ GATEWAY_ENABLED: "true", DEN_WORKBOT_URL: "https://workbot.example.com", INFERENCE_FREE_ENABLED: "1" }).infra)
      .toEqual({ gatewayEnabled: true, workbotConfigured: true, freeInferenceConfigured: true })
    expect(parseInstanceConfig({ DEN_WORKBOT_URL: "http://workbot.example.com" }).infra.workbotConfigured).toBe(false)
    expect(parseInstanceConfig({ DEN_WORKBOT_URL: "http://127.0.0.1:3000" }).infra.workbotConfigured).toBe(true)
    expect(parseInstanceConfig({ DEN_WORKBOT_URL: "not a url" }).infra.workbotConfigured).toBe(false)
    expect(() => parseInstanceConfig({ GATEWAY_ENABLED: "1" })).toThrow("GATEWAY_ENABLED")
    expect(() => parseInstanceConfig({ DEN_ORG_MODE: "both" })).toThrow("DEN_ORG_MODE")
    expect(parseInstanceConfig({ DEN_SLACK_ASSISTANT_WORKER_ENABLED: "0" }).deprecatedFlags.slackAssistantWorkerEnabled).toBe(true)
    expect(parseInstanceConfig({ DEN_SLACK_ASSISTANT_WORKER_ENABLED: "false" }).deprecatedFlags.slackAssistantWorkerEnabled).toBe(false)
  })
})

describe("resolveDeployment", () => {
  test("explicit DEN_DEPLOYMENT wins", () => {
    expect(describeDeployment({ DEN_DEPLOYMENT: "cloud" }, "single_org")).toEqual({ deployment: "cloud", source: "explicit" })
    expect(describeDeployment({ DEN_DEPLOYMENT: " self_hosted " }, "multi_org")).toEqual({ deployment: "selfHosted", source: "explicit" })
    expect(() => resolveDeployment({ DEN_DEPLOYMENT: "selfHosted" }, "multi_org")).toThrow("DEN_DEPLOYMENT")
  })

  test("unset derives from the org mode (00-legacy-mapping Q1)", () => {
    expect(describeDeployment({}, "multi_org")).toEqual({ deployment: "cloud", source: "derived" })
    expect(resolveDeployment({ DEN_DEPLOYMENT: "" }, "single_org")).toBe("selfHosted")
  })
})

describe("availability", () => {
  test("legacy probes (00-legacy-mapping §E.4 column A)", () => {
    const all = computeInstanceAvailability({ config: testInstanceConfig(), deployment: "cloud" })
    expect(unavailableModules(all)).toEqual([])
    const none = computeInstanceAvailability({
      config: testInstanceConfig({
        orgMode: "single_org",
        infra: { gatewayEnabled: false, headlessRunnerConfigured: false, workbotConfigured: false, cloudRuntimeAvailable: true, freeInferenceConfigured: false },
        deprecatedFlags: { automationsRuntimeEnabled: false, appMcpServersEnabled: false },
      }),
      deployment: "selfHosted",
    })
    expect(unavailableModules(none)).toEqual([
      "mcpApps",
      "automations",
      "automations.headless",
      "automations.remoteSessions",
      "workbot",
      "slackAssistant.headless",
      "aiGateway",
      "freeInference",
    ])
    expect(none.map.aiGateway).toEqual({ reason: "gateway_disabled" })
  })

  test("remote sessions stay available through the Cloud path (remoteSessionCapabilitiesEnabled)", () => {
    const config = testInstanceConfig({ orgMode: "multi_org", infra: { cloudRuntimeAvailable: true }, deprecatedFlags: { automationsRuntimeEnabled: false } })
    expect(AVAILABILITY_PROBES["automations.remoteSessions"](config, "cloud")).toBe(true)
    expect(AVAILABILITY_PROBES["automations.remoteSessions"]({ ...config, orgMode: "single_org" }, "cloud")).not.toBe(true)
  })

  test("non-observable modules report available; an observable module with unknown infrastructure throws", () => {
    const gatewayConfig = parseInstanceConfig({ GATEWAY_ENABLED: "true" })
    const snapshot = computeInstanceAvailability({ config: gatewayConfig, deployment: "cloud", observable: ["aiGateway", "freeInference"] })
    expect(snapshot.map["automations.headless"]).toBe(true)
    expect(snapshot.map.freeInference).toEqual({ reason: "free_inference_disabled" })
    expect(() => computeInstanceAvailability({ config: gatewayConfig, deployment: "cloud", observable: ["automations.headless"] }))
      .toThrow(UnknownInfrastructureError)
    expect(() => computeInstanceAvailability({ config: gatewayConfig, deployment: "cloud" })).toThrow(UnknownInfrastructureError)
  })

  test("every module has an entry and versions increase", () => {
    const first = computeInstanceAvailability({ config: testInstanceConfig(), deployment: "cloud" })
    const second = computeInstanceAvailability({ config: testInstanceConfig(), deployment: "cloud", probes: { teams: () => ({ reason: "test" }) } })
    expect(Object.keys(first.map)).toEqual([...MODULE_IDS])
    expect(second.version).toBeGreaterThan(first.version)
    expect(second.map.teams).toEqual({ reason: "test" })
  })
})
