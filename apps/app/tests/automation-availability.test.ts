import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const read = (relative: string) =>
  readFileSync(join(import.meta.dir, "..", relative), "utf8")

/**
 * Automations shipped out of preview, so there is no per-device preference.
 * Den now advertises deployment-level availability through desktop config;
 * Desktop must honor it across the route, runner, and proposal surface while
 * requiring every deployment to opt in explicitly.
 */
describe("Automations availability", () => {
  test("no preview feature flag remains in the local preferences", () => {
    const source = read("src/react-app/kernel/local-provider.tsx")
    expect(source).not.toContain("automations:")

    const flags = read("src/react-app/domains/settings/state/feature-flags-preferences.ts")
    expect(flags).not.toContain("automations")
  })

  test("the deployment gate stays off unless desktop config explicitly opts in", () => {
    const availability = read("src/react-app/domains/automations/automation-availability.ts")
    expect(availability).toContain("!loading && config.automationsEnabled === true")
  })

  test("the shell gates route, Den probe, and navigation on deployment availability for Desktop and Web alike", () => {
    const source = read("src/react-app/shell/session-route.tsx")
    expect(source).toContain("const automationDeploymentEnabled = useAutomationDeploymentEnabled()")
    expect(source).toContain("const automationsEnabled = automationDeploymentEnabled")
    expect(source).not.toContain("isDesktopRuntime() && automationDeploymentEnabled")
    expect(source).not.toContain("featureFlags?.automations")
    expect(source).toContain("automationsEnabled && automationsRouteRequested")
    expect(source).toContain("!automationsEnabled || !denAuth.isSignedIn")
    expect(source).toContain("automationsEnabled && automationsSupported")
  })

  test("the runner bridge registers only when the deployment contract allows it", () => {
    const providers = read("src/react-app/shell/providers.tsx")
    expect(providers).toContain("<AutomationRunnerBridge />")
    expect(providers).not.toContain("featureFlags")

    const bridge = read("src/react-app/domains/automations/automation-runner-bridge.tsx")
    expect(bridge).toContain("!deploymentEnabled || status !== \"signed_in\"")
    expect(bridge).toContain("[deploymentEnabled, status]")
    expect(bridge).toContain('automationRunnerConfigure", null')
    expect(bridge).toContain("onCredentialRejected?.(() => coordinator.credentialRejected())")
  })

  test("credential rejection crosses only the Automation runner Electron bridge", () => {
    const main = read("../desktop/electron/main.mjs")
    const preload = read("../desktop/electron/preload.mjs")
    expect(main).toContain('"openwork:automation-runner:credential-rejected"')
    expect(main).toContain("onCredentialRejected: () =>")
    expect(preload).toContain("onCredentialRejected(callback)")
    expect(preload).toContain("ipcRenderer.on(AUTOMATION_RUNNER_CREDENTIAL_REJECTED_EVENT, handler)")
  })

  test("the in-chat proposal tool blocks creation when the deployment disables Automations", () => {
    const proposal = read("src/components/tools/openwork-automation-proposal.tsx")
    expect(proposal).toContain("useAutomationDeploymentEnabled()")
    expect(proposal).toContain("Automations are disabled for this deployment.")
    expect(proposal).toContain("if (!automationsEnabled) return")
    expect(proposal).toContain("Sign in to OpenWork Cloud")
    expect(proposal).toContain("resolveProposalModel")
    expect(proposal).toContain("data-automation-model-resolution")
  })

  test("the creating surface fixes placement: Desktop stays local, every browser runtime is Cloud", () => {
    const availability = read("src/react-app/domains/automations/automation-availability.ts")
    expect(availability).toContain('return isDesktopRuntime() ? "desktop" : "cloud"')

    const page = read("src/react-app/domains/automations/automations-page.tsx")
    expect(page).toContain("const placement = automationCreationPlacement()")
    expect(page).toContain('placement === "cloud"\n                ? await client.createCloudAutomation(organizationId, {')
    expect(page).toContain(": await client.createAutomation(organizationId, {")
    // The free Zen starter is a published-Desktop exception that Cloud revalidation rejects.
    expect(page).toContain('includeFreeStarter: placement === "desktop" && !zenModelRestricted && freeStarterInRuntime')

    const proposal = read("src/components/tools/openwork-automation-proposal.tsx")
    expect(proposal).toContain("const placement = automationCreationPlacement()")
    expect(proposal).toContain('placement === "cloud"\n        ? await client.createCloudAutomation(organizationId, {')
  })

  test("the desktop runner never registers from a browser runtime", () => {
    const bridge = read("src/react-app/domains/automations/automation-runner-bridge.tsx")
    expect(bridge).toContain("if (!isDesktopRuntime() || !window.__OPENWORK_ELECTRON__?.invokeDesktop) return")
  })

  test("the automations capability is listed for every runtime", () => {
    const controls = read("src/react-app/shell/control/control-provider.tsx")
    expect(controls).toContain('{ id: "automations", label: "Automations", description: "Schedule recurring tasks and background agents." }')
    expect(controls).not.toContain("...(isDesktopRuntime()\n            ? [{ id: \"automations\"")
  })
})
