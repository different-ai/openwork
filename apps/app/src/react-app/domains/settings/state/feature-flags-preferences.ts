import { useCallback, useEffect } from "react";
import {
  UI_ARTIFACT_KINDS,
  uiArtifactKindSchema,
  type UiArtifactKind,
  type UiArtifactPreferencesUpdate,
} from "@openwork/types/ui-artifact";

import { createDenClient, readDenSettings } from "../../../../app/lib/den";
import {
  denSessionUpdatedEvent,
  denSettingsChangedEvent,
} from "../../../../app/lib/den-session-events";
import { useLocal, useOptionalLocal } from "../../../kernel/local-provider";

let uiArtifactPreferenceSync:
  | { key: string; promise: ReturnType<ReturnType<typeof createDenClient>["getUiArtifactPreferences"]> }
  | null = null;

function currentDenArtifactClient() {
  const settings = readDenSettings();
  const token = settings.authToken?.trim() ?? "";
  const orgId = settings.activeOrgId?.trim() ?? "";
  if (!token || !orgId) return null;
  return {
    key: `${settings.baseUrl}::${orgId}::${token}`,
    orgId,
    client: createDenClient({ baseUrl: settings.baseUrl, token }),
  };
}

function readCloudUiArtifactPreferences() {
  const current = currentDenArtifactClient();
  if (!current) return null;
  if (uiArtifactPreferenceSync?.key === current.key) return uiArtifactPreferenceSync.promise;
  const promise = current.client.getUiArtifactPreferences(current.orgId);
  uiArtifactPreferenceSync = { key: current.key, promise };
  void promise.catch(() => {
    if (uiArtifactPreferenceSync?.promise === promise) uiArtifactPreferenceSync = null;
  });
  return promise;
}

function writeCloudUiArtifactPreferences(update: UiArtifactPreferencesUpdate) {
  const current = currentDenArtifactClient();
  if (!current) return null;
  return current.client.updateUiArtifactPreferences(current.orgId, update).then((result) => {
    uiArtifactPreferenceSync = {
      key: current.key,
      promise: Promise.resolve(result),
    };
    return result;
  });
}

export function useUiArtifactPreferencesSnapshot() {
  const local = useOptionalLocal();
  const uiArtifactsEnabled = local?.prefs.featureFlags?.uiArtifacts === true;
  const enabledUiArtifactIds = (local?.prefs.uiArtifacts?.enabledArtifactIds ?? UI_ARTIFACT_KINDS)
    .flatMap((value) => {
      const parsed = uiArtifactKindSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
  return { uiArtifactsEnabled, enabledUiArtifactIds };
}

export function useFeatureFlagsPreferences() {
  const { prefs, setPrefs } = useLocal();

  const microsandboxCreateSandboxEnabled =
    prefs.featureFlags?.microsandboxCreateSandbox === true;

  const toggleMicrosandboxCreateSandbox = useCallback(() => {
    setPrefs((previous) => ({
      ...previous,
      featureFlags: {
        ...previous.featureFlags,
        microsandboxCreateSandbox: !previous.featureFlags?.microsandboxCreateSandbox,
      },
    }));
  }, [setPrefs]);

  const memoryEnabled = prefs.featureFlags?.memory === true;

  const toggleMemory = useCallback(() => {
    setPrefs((previous) => ({
      ...previous,
      featureFlags: {
        ...previous.featureFlags,
        memory: !previous.featureFlags?.memory,
      },
    }));
  }, [setPrefs]);

  const { uiArtifactsEnabled, enabledUiArtifactIds } = useUiArtifactPreferencesSnapshot();

  const applyCloudPreferences = useCallback((cloud: {
    enabled: boolean;
    enabledArtifactIds: UiArtifactKind[];
  }) => {
    setPrefs((previous) => ({
      ...previous,
      featureFlags: {
        ...previous.featureFlags,
        uiArtifacts: cloud.enabled,
      },
      uiArtifacts: {
        enabledArtifactIds: [...cloud.enabledArtifactIds],
      },
    }));
  }, [setPrefs]);

  useEffect(() => {
    let disposed = false;
    const sync = () => {
      const request = readCloudUiArtifactPreferences();
      if (!request) return;
      void request.then((cloud) => {
        if (!disposed) applyCloudPreferences(cloud);
      }).catch(() => {
        // Keep the last confirmed state during a temporary control-plane outage.
      });
    };

    sync();
    const handleSessionChange = () => {
      uiArtifactPreferenceSync = null;
      sync();
    };
    window.addEventListener(denSessionUpdatedEvent, handleSessionChange);
    window.addEventListener(denSettingsChangedEvent, handleSessionChange);
    return () => {
      disposed = true;
      window.removeEventListener(denSessionUpdatedEvent, handleSessionChange);
      window.removeEventListener(denSettingsChangedEvent, handleSessionChange);
    };
  }, [applyCloudPreferences]);

  const toggleUiArtifacts = useCallback(() => {
    const nextEnabled = !uiArtifactsEnabled;
    const update = {
      enabled: nextEnabled,
      enabledArtifactIds: enabledUiArtifactIds,
    } satisfies UiArtifactPreferencesUpdate;
    setPrefs((previous) => ({
      ...previous,
      featureFlags: {
        ...previous.featureFlags,
        uiArtifacts: nextEnabled,
      },
    }));
    const request = writeCloudUiArtifactPreferences(update);
    if (!request) return;
    void request
      .then(applyCloudPreferences)
      .catch(() => {
        setPrefs((previous) => ({
          ...previous,
          featureFlags: {
            ...previous.featureFlags,
            uiArtifacts: uiArtifactsEnabled,
          },
        }));
      });
  }, [
    applyCloudPreferences,
    enabledUiArtifactIds,
    setPrefs,
    uiArtifactsEnabled,
  ]);

  const toggleUiArtifact = useCallback((artifactId: UiArtifactKind) => {
    const nextArtifactIds = enabledUiArtifactIds.includes(artifactId)
      ? enabledUiArtifactIds.filter((value) => value !== artifactId)
      : [...enabledUiArtifactIds, artifactId];
    setPrefs((previous) => ({
      ...previous,
      uiArtifacts: { enabledArtifactIds: nextArtifactIds },
    }));
    const request = writeCloudUiArtifactPreferences({
      enabled: uiArtifactsEnabled,
      enabledArtifactIds: nextArtifactIds,
    });
    if (!request) return;
    void request
      .then(applyCloudPreferences)
      .catch(() => {
        setPrefs((previous) => ({
          ...previous,
          uiArtifacts: { enabledArtifactIds: enabledUiArtifactIds },
        }));
      });
  }, [
    applyCloudPreferences,
    enabledUiArtifactIds,
    setPrefs,
    uiArtifactsEnabled,
  ]);

  return {
    microsandboxCreateSandboxEnabled,
    toggleMicrosandboxCreateSandbox,
    memoryEnabled,
    toggleMemory,
    uiArtifactsEnabled,
    enabledUiArtifactIds,
    toggleUiArtifacts,
    toggleUiArtifact,
  };
}
