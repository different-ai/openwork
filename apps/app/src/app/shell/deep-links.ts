import { createEffect, createSignal, type Accessor } from "solid-js";

import { createDenClient, writeDenSettings } from "../lib/den";
import { stripBundleQuery } from "../bundles";
import type { createBundlesStore } from "../bundles/store";
import type { SettingsTab, View } from "../types";
import type { WorkspaceStore } from "../context/workspace";
import { isTauriRuntime } from "../utils";
import {
  parseDebugDeepLinkInput,
  parseDenAuthDeepLink,
  parseRemoteConnectDeepLink,
  stripRemoteConnectQuery,
  type DenAuthDeepLink,
  type RemoteWorkspaceDefaults,
} from "../lib/openwork-links";

export type DeepLinksController = ReturnType<typeof createDeepLinksController>;

export function createDeepLinksController(options: {
  booting: Accessor<boolean>;
  setError: (value: string | null) => void;
  setView: (next: View, sessionId?: string) => void;
  setSettingsTab: (value: SettingsTab) => void;
  goToSettings: (value: SettingsTab) => void;
  workspaceStore: WorkspaceStore;
  bundlesStore: ReturnType<typeof createBundlesStore>;
}) {
  const [deepLinkRemoteWorkspaceDefaults, setDeepLinkRemoteWorkspaceDefaults] =
    createSignal<RemoteWorkspaceDefaults | null>(null);
  const [pendingRemoteConnectDeepLink, setPendingRemoteConnectDeepLink] =
    createSignal<RemoteWorkspaceDefaults | null>(null);
  const [pendingDenAuthDeepLink, setPendingDenAuthDeepLink] = createSignal<DenAuthDeepLink | null>(null);
  const [processingDenAuthDeepLink, setProcessingDenAuthDeepLink] = createSignal(false);
  const recentClaimedDeepLinks = new Map<string, number>();

  const queueRemoteConnectDefaults = (pending: RemoteWorkspaceDefaults | null) => {
    setPendingRemoteConnectDeepLink(pending);
  };

  const clearDeepLinkRemoteWorkspaceDefaults = () => {
    setDeepLinkRemoteWorkspaceDefaults(null);
  };

  const queueRemoteConnectDeepLink = (rawUrl: string): boolean => {
    const parsed = parseRemoteConnectDeepLink(rawUrl);
    if (!parsed) {
      return false;
    }
    setPendingRemoteConnectDeepLink(parsed);
    return true;
  };

  const completeRemoteConnectDeepLink = async (pending: RemoteWorkspaceDefaults) => {
    const input = {
      openworkHostUrl: pending.openworkHostUrl,
      openworkToken: pending.openworkToken,
      openworkConnectGrant: pending.openworkConnectGrant,
      denBaseUrl: pending.denBaseUrl,
      directory: pending.directory,
      displayName: pending.displayName,
    };

    if (!pending.autoConnect) {
      setDeepLinkRemoteWorkspaceDefaults(input);
      options.workspaceStore.setCreateRemoteWorkspaceOpen(true);
      return;
    }

    options.setError(null);
    try {
      const ok = await options.workspaceStore.createRemoteWorkspaceFlow(input);
      if (ok) {
        setDeepLinkRemoteWorkspaceDefaults(null);
        return;
      }

      setDeepLinkRemoteWorkspaceDefaults(input);
      options.workspaceStore.setCreateRemoteWorkspaceOpen(true);
    } finally {
      // no-op overlay placeholder removed; shell has no consumer
    }
  };

  const queueDenAuthDeepLink = (rawUrl: string): boolean => {
    const parsed = parseDenAuthDeepLink(rawUrl);
    if (!parsed) {
      return false;
    }
    setPendingDenAuthDeepLink(parsed);
    return true;
  };

  const stripHandledBrowserDeepLink = (rawUrl: string) => {
    if (typeof window === "undefined" || isTauriRuntime()) {
      return;
    }

    if (window.location.href !== rawUrl) {
      return;
    }

    const remoteStripped = stripRemoteConnectQuery(rawUrl) ?? rawUrl;
    const bundleStripped = stripBundleQuery(remoteStripped) ?? remoteStripped;
    if (bundleStripped !== rawUrl) {
      window.history.replaceState({}, "", bundleStripped);
    }
  };

  const consumeDeepLinks = (urls: readonly string[] | null | undefined) => {
    if (!Array.isArray(urls)) {
      return;
    }

    const normalized = urls.map((url) => url.trim()).filter(Boolean);
    if (normalized.length === 0) {
      return;
    }

    const now = Date.now();
    for (const [url, seenAt] of recentClaimedDeepLinks) {
      if (now - seenAt > 1500) {
        recentClaimedDeepLinks.delete(url);
      }
    }

    for (const url of normalized) {
      const seenAt = recentClaimedDeepLinks.get(url) ?? 0;
      if (now - seenAt < 1500) {
        continue;
      }

      const matchedDen = queueDenAuthDeepLink(url);
      const matchedRemote = !matchedDen && queueRemoteConnectDeepLink(url);
      const matchedBundle = !matchedDen && !matchedRemote && options.bundlesStore.queueBundleLink(url);
      const claimed = matchedDen || matchedRemote || matchedBundle;
      if (!claimed) {
        continue;
      }

      recentClaimedDeepLinks.set(url, now);
      stripHandledBrowserDeepLink(url);
      break;
    }
  };

  const openDebugDeepLink = async (rawUrl: string): Promise<{ ok: boolean; message: string }> => {
    const parsed = parseDebugDeepLinkInput(rawUrl);
    if (!parsed) {
      return { ok: false, message: "That link is not a recognized OpenWork deep link or share URL." };
    }

    options.setError(null);
    options.setView("settings");
    if (parsed.kind === "bundle") {
      return options.bundlesStore.openDebugBundleRequest(parsed.link);
    }
    if (parsed.kind === "auth") {
      setPendingDenAuthDeepLink(parsed.link);
      return { ok: true, message: "Queued the Cloud auth deep link for OpenWork." };
    }

    setPendingRemoteConnectDeepLink(parsed.kind === "remote" ? parsed.link : null);
    options.setSettingsTab("automations");
    return { ok: true, message: "Queued remote worker link. OpenWork should move into the connect flow." };
  };

  createEffect(() => {
    const pending = pendingDenAuthDeepLink();
    if (!pending || options.booting() || processingDenAuthDeepLink()) {
      return;
    }

    setProcessingDenAuthDeepLink(true);
    setPendingDenAuthDeepLink(null);
    options.setView("settings");
    options.setSettingsTab("den");
    options.goToSettings("den");

    void createDenClient({ baseUrl: pending.denBaseUrl })
      .exchangeDesktopHandoff(pending.grant)
      .then((result) => {
        if (!result.token) {
          throw new Error("Desktop sign-in completed, but OpenWork Cloud did not return a session token.");
        }

        writeDenSettings({
          baseUrl: pending.denBaseUrl,
          authToken: result.token,
          activeOrgId: null,
          activeOrgSlug: null,
          activeOrgName: null,
        });

        window.dispatchEvent(
          new CustomEvent("openwork-den-session-updated", {
            detail: {
              status: "success",
              email: result.user?.email ?? null,
            },
          }),
        );
      })
      .catch((error) => {
        window.dispatchEvent(
          new CustomEvent("openwork-den-session-updated", {
            detail: {
              status: "error",
              message: error instanceof Error ? error.message : "Failed to complete OpenWork Cloud sign-in.",
            },
          }),
        );
      })
      .finally(() => {
        setProcessingDenAuthDeepLink(false);
      });
  });

  createEffect(() => {
    const pending = pendingRemoteConnectDeepLink();
    if (!pending || options.booting()) {
      return;
    }

    if (pending.autoConnect) {
      options.setView("session");
    } else {
      options.setView("settings");
      options.setSettingsTab("automations");
    }
    setPendingRemoteConnectDeepLink(null);
    void completeRemoteConnectDeepLink(pending);
  });

  createEffect(() => {
    if (options.workspaceStore.createRemoteWorkspaceOpen()) {
      return;
    }
    if (!deepLinkRemoteWorkspaceDefaults()) {
      return;
    }
    setDeepLinkRemoteWorkspaceDefaults(null);
  });

  return {
    deepLinkRemoteWorkspaceDefaults,
    clearDeepLinkRemoteWorkspaceDefaults,
    queueRemoteConnectDefaults,
    consumeDeepLinks,
    openDebugDeepLink,
  };
}
