import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const read = (relative: string) =>
  readFileSync(join(import.meta.dir, "..", relative), "utf8")

/**
 * The Automations preview stays behind an explicit, per-device opt-in. These
 * checks pin the contract so a refactor cannot silently ship the surface
 * enabled or drop the gate from one of its consumers.
 */
describe("Automations feature flag", () => {
  test("defaults to off in the initial local preferences", () => {
    const source = read("src/react-app/kernel/local-provider.tsx")
    const initial = source.match(/INITIAL_PREFS[\s\S]*?featureFlags:\s*\{([^}]*)\}/)?.[1] ?? ""
    expect(initial).toContain("automations: false")
  })

  test("preferences expose an explicit opt-in toggle", () => {
    const source = read("src/react-app/domains/settings/state/feature-flags-preferences.ts")
    expect(source).toContain("prefs.featureFlags?.automations === true")
    expect(source).toContain("toggleAutomations")
  })

  test("the shell gates route, Den probe, navigation, and runner registration on the flag", () => {
    const source = read("src/react-app/shell/session-route.tsx")
    expect(source).toContain("local.prefs.featureFlags?.automations === true")
    expect(source).toContain("automationsEnabled && automationsRouteRequested")
    expect(source).toContain("!automationsEnabled || !denAuth.isSignedIn")
    expect(source).toContain("automationsEnabled && automationsSupported")

    const providers = read("src/react-app/shell/providers.tsx")
    expect(providers).toContain("prefs.featureFlags?.automations === true")
    expect(providers).toContain("<AutomationRunnerBridge enabled=")

    const bridge = read("src/react-app/domains/automations/automation-runner-bridge.tsx")
    expect(bridge).toContain("!enabled || status !== \"signed_in\"")
    expect(bridge).toContain("[enabled, status]")
    expect(bridge).toContain('automationRunnerConfigure", null')
  })

  test("every locale carries the shared Automations preferences copy", () => {
    const locales = ["en", "ca", "es", "fr", "ja", "pt-BR", "ru", "th", "vi", "zh"]
    for (const locale of locales) {
      expect(read(`src/i18n/locales/${locale}.ts`)).toContain("...automationsEnglish")
    }
  })
})
