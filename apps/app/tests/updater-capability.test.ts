import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  electronUpdaterRequiresPackagedBuild,
  missingElectronUpdaterMethods,
} from "../src/react-app/domains/settings/state/electron-updater-state";
import { UpdatesView } from "../src/react-app/domains/settings/pages/updates-view";
import ca from "../src/i18n/locales/ca";
import en from "../src/i18n/locales/en";
import es from "../src/i18n/locales/es";
import fr from "../src/i18n/locales/fr";
import ja from "../src/i18n/locales/ja";
import ptBR from "../src/i18n/locales/pt-BR";
import th from "../src/i18n/locales/th";
import vi from "../src/i18n/locales/vi";
import zh from "../src/i18n/locales/zh";

const noop = () => {};
const updaterCapabilityKeys = [
  "settings.updates_bridge_unavailable",
  "settings.updates_checking_support",
  "settings.updates_packaged_only",
] as const;
const locales = { ca, en, es, fr, ja, "pt-BR": ptBR, th, vi, zh };

function renderUpdatesView(overrides: Partial<React.ComponentProps<typeof UpdatesView>> = {}) {
  return renderToStaticMarkup(
    React.createElement(UpdatesView, {
      busy: false,
      webDeployment: false,
      appVersion: "0.12.7",
      updateEnv: { supported: true },
      updateAutoCheck: true,
      toggleUpdateAutoCheck: noop,
      updateAutoDownload: false,
      toggleUpdateAutoDownload: noop,
      updateStatus: null,
      anyActiveRuns: false,
      checkForUpdates: noop,
      downloadUpdate: noop,
      installUpdateAndRestart: noop,
      releaseChannel: "stable",
      onReleaseChannelChange: noop,
      alphaChannelSupported: true,
      ...overrides,
    }),
  );
}

describe("updater capability gating", () => {
  test("requires the complete Electron updater bridge before enabling controls", () => {
    expect(missingElectronUpdaterMethods(null)).toEqual([
      "getChannel",
      "setChannel",
      "check",
      "download",
      "installAndRestart",
    ]);

    expect(
      missingElectronUpdaterMethods({
        getChannel: async () => ({ channel: "stable", feedUrl: "", currentVersion: "0.12.7" }),
        setChannel: async () => ({ channel: "stable", feedUrl: "", currentVersion: "0.12.7" }),
        check: async () => ({ available: false }),
      }),
    ).toEqual(["download", "installAndRestart"]);
  });

  test("treats development Electron builds as unsupported for update checks", () => {
    expect(electronUpdaterRequiresPackagedBuild({ updateChecksSupported: false })).toBe(true);
    expect(electronUpdaterRequiresPackagedBuild({ reason: "unavailable" })).toBe(true);
    expect(electronUpdaterRequiresPackagedBuild({ updateChecksSupported: true })).toBe(false);
  });

  test("does not render update actions before updater support is known", () => {
    const html = renderUpdatesView({ updateEnv: null });

    expect(html).toContain("Checking update support");
    expect(html).not.toContain("Release channel");
    expect(html).not.toContain(">Check<");
  });

  test("does not render update actions when updater bridge is unavailable", () => {
    const html = renderUpdatesView({
      updateEnv: {
        supported: false,
        reason: "Updater bridge is unavailable. Restart OpenWork and try again.",
      },
    });

    expect(html).toContain("Updater bridge is unavailable");
    expect(html).not.toContain(">Check<");
  });

  test("defines updater capability copy for every locale", () => {
    for (const [locale, messages] of Object.entries(locales)) {
      for (const key of updaterCapabilityKeys) {
        const value = messages[key as keyof typeof messages];
        expect(typeof value, `${locale}:${key}`).toBe("string");
        expect(String(value).length, `${locale}:${key}`).toBeGreaterThan(0);
      }
    }
  });
});
