import { describe, expect, test } from "bun:test";

import type {
  SettingsExtensionDescriptor,
  SettingsExtensionRegistration,
} from "../src/react-app/domains/settings/extension-registry";
import {
  APP_SETTINGS_EXTENSION_CONTRIBUTIONS,
  appSettingsExtensionComposition,
  createSettingsExtensionComposition,
} from "../src/react-app/domains/settings/settings-extension-composition";

const LEGACY_SETTINGS_EXTENSION_INVENTORY = [
  {
    id: "openai-image-gen",
    settingsPanelRefs: ["openwork.imageGen.settings", "openai-image-gen"],
    connectionRefs: [],
  },
  {
    id: "ollama",
    settingsPanelRefs: ["openwork.ollama.settings", "ollama"],
    connectionRefs: [],
  },
  {
    id: "computer-use",
    settingsPanelRefs: ["computer-use"],
    connectionRefs: [],
  },
  {
    id: "openwork-browser",
    settingsPanelRefs: ["openwork.browser.settings", "openwork-browser"],
    connectionRefs: [],
  },
  {
    id: "openwork-voice",
    settingsPanelRefs: ["openwork.voice.settings", "openwork-voice"],
    connectionRefs: [],
  },
  {
    id: "google-workspace",
    settingsPanelRefs: ["google-workspace", "openwork.googleWorkspace.settings"],
    connectionRefs: ["google-workspace"],
  },
] as const;

function fakeDescriptor(
  id: string,
  settingsPanelRefs: readonly string[],
  order: number,
): SettingsExtensionDescriptor {
  return {
    id,
    kind: "app.settings-extension",
    contractVersion: 1,
    provenance: { packageName: "@openwork/app-test", source: "test" },
    order,
    settingsPanelRefs,
    connectionRefs: [],
  };
}

function fakeContribution(
  id: string,
  settingsPanelRefs: readonly string[],
  order: number,
): SettingsExtensionRegistration {
  return {
    descriptor: fakeDescriptor(id, settingsPanelRefs, order),
    binding: {
      status: "ready",
      create: () => ({ settingsPanel: () => null }),
    },
  };
}

describe("app settings extension composition", () => {
  test("preserves the exact legacy settings inventory and order", () => {
    expect(Object.isFrozen(appSettingsExtensionComposition.descriptors)).toBe(true);
    expect(appSettingsExtensionComposition.descriptors.map((descriptor) => ({
      id: descriptor.id,
      settingsPanelRefs: descriptor.settingsPanelRefs,
      connectionRefs: descriptor.connectionRefs,
    }))).toEqual(LEGACY_SETTINGS_EXTENSION_INVENTORY);

    for (const expected of LEGACY_SETTINGS_EXTENSION_INVENTORY) {
      for (const ref of expected.settingsPanelRefs) {
        const result = appSettingsExtensionComposition.lookupSettingsPanel(ref);
        expect(result.status).toBe("found");
        if (result.status === "found") expect(result.descriptor.id).toBe(expected.id);
      }
    }
    expect(appSettingsExtensionComposition.lookupConnection("google-workspace").status).toBe("found");
  });

  test("assembles deterministically by declared order instead of import timing", () => {
    const later = fakeContribution("test.settings.later", ["test.settings.later.panel"], 20);
    const earlier = fakeContribution("test.settings.earlier", ["test.settings.earlier.panel"], 10);

    const composition = createSettingsExtensionComposition([later, earlier]);

    expect(composition.descriptors.map((descriptor) => descriptor.id)).toEqual([
      "test.settings.earlier",
      "test.settings.later",
    ]);
  });

  test("rejects duplicate contribution ids and duplicate panel refs", () => {
    const contribution = fakeContribution("test.settings.duplicate", ["test.settings.duplicate.panel"], 10);
    expect(() => createSettingsExtensionComposition([contribution, contribution])).toThrow(
      "App settings extension composition is invalid",
    );

    expect(() => createSettingsExtensionComposition([
      fakeContribution("test.settings.first", ["test.settings.shared.panel"], 10),
      fakeContribution("test.settings.second", ["test.settings.shared.panel"], 20),
    ])).toThrow("Duplicate app settings extension ref");
  });

  test("keeps composition valid when a contribution is omitted and reports unknown", () => {
    const withoutBrowser = APP_SETTINGS_EXTENSION_CONTRIBUTIONS.filter(
      (contribution) => contribution.descriptor.id !== "openwork-browser",
    );

    const composition = createSettingsExtensionComposition(withoutBrowser);

    expect(composition.descriptors.some((descriptor) => descriptor.id === "openwork-browser")).toBe(false);
    expect(composition.lookupSettingsPanel("openwork.browser.settings")).toEqual({
      status: "unknown",
      ref: "openwork.browser.settings",
    });
  });

  test("reports disabled bindings without breaking other contributions", () => {
    const disabled: SettingsExtensionRegistration = {
      descriptor: fakeDescriptor("test.settings.disabled", ["test.settings.disabled.panel"], 10),
      binding: { status: "disabled", reason: "Disabled for this renderer." },
    };
    const ready = fakeContribution("test.settings.ready", ["test.settings.ready.panel"], 20);

    const composition = createSettingsExtensionComposition([disabled, ready]);

    expect(composition.lookupSettingsPanel("test.settings.disabled.panel")).toEqual({
      status: "unavailable",
      ref: "test.settings.disabled.panel",
      descriptor: disabled.descriptor,
      reason: "Disabled for this renderer.",
    });
    expect(composition.lookupSettingsPanel("test.settings.ready.panel").status).toBe("found");
  });
});
