import { createEffect, untrack, type Accessor } from "solid-js";

import {
  hydrateOpenworkServerSettingsFromEnv,
  readOpenworkBundleInviteFromSearch,
  readOpenworkConnectInviteFromSearch,
  readOpenworkServerSettings,
  stripOpenworkBundleInviteFromUrl,
  stripOpenworkConnectInviteFromUrl,
  writeOpenworkServerSettings,
  type OpenworkServerSettings,
} from "../lib/openwork-server";
import {
  normalizeSharedBundleImportIntent,
  type RemoteWorkspaceDefaults,
  type SharedBundleImportIntent,
} from "../lib/shared-bundles";
import type { StartupPreference } from "../types";

type StartupSharedBundleInvite = {
  bundleUrl: string;
  intent: SharedBundleImportIntent;
  source?: string;
  orgId?: string;
  label?: string;
};

type UseOpenworkServerBootstrapOptions = {
  onboardingStep: Accessor<string>;
  setStartupPreference: (value: StartupPreference) => void;
  setOnboardingStep: (value: string) => void;
  setOpenworkServerSettings: (value: OpenworkServerSettings) => void;
  setStartupSharedBundleInvite: (value: StartupSharedBundleInvite | null) => void;
  setPendingRemoteConnectDeepLink: (value: RemoteWorkspaceDefaults | null) => void;
};

export function useOpenworkServerBootstrap(options: UseOpenworkServerBootstrapOptions) {
  createEffect(() => {
    if (typeof window === "undefined") return;

    hydrateOpenworkServerSettingsFromEnv();

    const stored = readOpenworkServerSettings();
    const invite = readOpenworkConnectInviteFromSearch(window.location.search);
    const bundleInvite = readOpenworkBundleInviteFromSearch(window.location.search);

    if (!invite) {
      options.setOpenworkServerSettings(stored);
    } else {
      const merged: OpenworkServerSettings = {
        ...stored,
        urlOverride: invite.url,
        token: invite.token ?? stored.token,
      };

      const next = writeOpenworkServerSettings(merged);
      options.setOpenworkServerSettings(next);

      if (invite.startup === "server" && untrack(options.onboardingStep) === "welcome") {
        options.setStartupPreference("server");
        options.setOnboardingStep("server");
      }
    }

    if (bundleInvite?.bundleUrl) {
      options.setStartupSharedBundleInvite({
        bundleUrl: bundleInvite.bundleUrl,
        intent: normalizeSharedBundleImportIntent(bundleInvite.intent),
        source: bundleInvite.source ?? undefined,
        orgId: bundleInvite.orgId ?? undefined,
        label: bundleInvite.label ?? undefined,
      });
    }

    if (invite?.autoConnect) {
      options.setPendingRemoteConnectDeepLink({
        openworkHostUrl: invite.url,
        openworkToken: invite.token ?? null,
        directory: null,
        displayName: null,
        autoConnect: true,
      });
    }

    const cleanedConnect = stripOpenworkConnectInviteFromUrl(window.location.href);
    const cleaned = stripOpenworkBundleInviteFromUrl(cleanedConnect);
    if (cleaned !== window.location.href) {
      window.history.replaceState(window.history.state ?? null, "", cleaned);
    }
  });
}
