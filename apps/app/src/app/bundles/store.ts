import { createEffect, createMemo, createSignal, onCleanup, untrack, type Accessor } from "solid-js";

import type {
  ReloadReason,
  ReloadTrigger,
  SettingsTab,
  View,
  WorkspacePreset,
} from "../types";
import { normalizeOpenworkServerUrl, parseOpenworkWorkspaceIdFromUrl } from "../lib/openwork-server";
import { t } from "../../i18n";
import { isTauriRuntime, safeStringify, addOpencodeCacheHint } from "../utils";
import type { WorkspaceStore } from "../context/workspace";
import type { StartupPreference } from "../types";
import type { OpenworkServerStore } from "../connections/openwork-server-store";
import {
  buildImportPayloadFromBundle,
  describeWorkspaceForBundleToasts,
  isBundleImportWorkspace,
  resolveBundleImportTargetForWorkspace,
} from "./apply";
import { defaultPresetFromWorkspaceProfileBundle, describeBundleImport, parseBundlePayload } from "./schema";
import { fetchBundle, parseBundleDeepLink } from "./sources";
import { describeBundleUrlTrust } from "./url-policy";
import type {
  BundleCreateWorkspaceRequest,
  BundleImportChoice,
  BundleImportSummary,
  BundleImportTarget,
  BundleRequest,
  BundleStartRequest,
  BundleWorkerOption,
  BundleV1,
  SkillDestinationRequest,
  WorkspaceProfileBundleV1,
} from "./types";
import type { AppStatusToastInput } from "../shell/status-toasts";

type BundleProcessResult =
  | { mode: "choice"; bundle: BundleV1 }
  | { mode: "start_modal"; bundle: BundleV1 }
  | { mode: "blocked_import_current"; bundle: BundleV1 }
  | { mode: "blocked_new_worker"; bundle: BundleV1 }
  | { mode: "untrusted_warning" }
  | { mode: "imported"; bundle: BundleV1 };

type UntrustedBundleWarning = {
  request: BundleRequest;
  actualOrigin: string | null;
  configuredOrigin: string | null;
};

export type BundlesStore = ReturnType<typeof createBundlesStore>;

export function createBundlesStore(options: {
  booting: Accessor<boolean>;
  startupPreference: Accessor<StartupPreference | null>;
  openworkServer: OpenworkServerStore;
  runtimeWorkspaceId: Accessor<string | null>;
  workspaceStore: WorkspaceStore;
  setError: (value: string | null) => void;
  error: Accessor<string | null>;
  setView: (next: View, sessionId?: string) => void;
  setSettingsTab: (nextTab: SettingsTab) => void;
  refreshActiveWorkspaceServerConfig: (workspaceId: string) => Promise<unknown>;
  refreshSkills: (input?: { force?: boolean }) => Promise<unknown>;
  refreshHubSkills: (input?: { force?: boolean }) => Promise<unknown>;
  markReloadRequired: (reason: ReloadReason, trigger?: ReloadTrigger) => void;
  showStatusToast: (toast: AppStatusToastInput) => void;
}) {
  const [pendingBundleRequest, setPendingBundleRequest] = createSignal<BundleRequest | null>(null);
  const [bundleStartRequest, setBundleStartRequest] = createSignal<BundleStartRequest | null>(null);
  const [bundleStartBusy, setBundleStartBusy] = createSignal(false);
  const [createWorkspaceRequest, setCreateWorkspaceRequest] = createSignal<BundleCreateWorkspaceRequest | null>(null);
  const [skillDestinationRequest, setSkillDestinationRequest] = createSignal<SkillDestinationRequest | null>(null);
  const [skillDestinationBusyId, setSkillDestinationBusyId] = createSignal<string | null>(null);
  const [bundleImportChoice, setBundleImportChoice] = createSignal<BundleImportChoice | null>(null);
  const [bundleImportBusy, setBundleImportBusy] = createSignal(false);
  const [bundleImportError, setBundleImportError] = createSignal<string | null>(null);
  const [bundleNoticeShown, setBundleNoticeShown] = createSignal(false);
  const [untrustedBundleWarning, setUntrustedBundleWarning] = createSignal<UntrustedBundleWarning | null>(null);

  const showSkillSuccessToast = (toast: { title: string; description: string }) => {
    options.showStatusToast({
      ...toast,
      tone: "success",
      durationMs: 4200,
    });
  };

  const resetInteractiveBundleState = () => {
    setSkillDestinationRequest(null);
    setSkillDestinationBusyId(null);
    setBundleImportChoice(null);
    setBundleStartRequest(null);
    setCreateWorkspaceRequest(null);
    setBundleImportError(null);
    setBundleNoticeShown(false);
    setUntrustedBundleWarning(null);
  };

  const maybeWarnAboutUntrustedBundle = (request: BundleRequest, options?: { allowUntrustedClientFetch?: boolean }) => {
    const rawUrl = request.bundleUrl?.trim() ?? "";
    if (!rawUrl || options?.allowUntrustedClientFetch) return false;
    const trust = describeBundleUrlTrust(rawUrl);
    if (trust.trusted) return false;
    setUntrustedBundleWarning({
      request,
      actualOrigin: trust.actualOrigin,
      configuredOrigin: trust.configuredOrigin,
    });
    return true;
  };

  const resolveBundleWorkerTarget = () => {
    const pref = options.startupPreference();
    const hostInfo = options.openworkServer.openworkServerHostInfo();
    const settings = options.openworkServer.openworkServerSettings();

    const localHostUrl = normalizeOpenworkServerUrl(hostInfo?.baseUrl ?? "") ?? "";
    const localToken = hostInfo?.clientToken?.trim() ?? "";
    const serverHostUrl = normalizeOpenworkServerUrl(settings.urlOverride ?? "") ?? "";
    const serverToken = settings.token?.trim() ?? "";

    if (pref === "server") {
      return {
        hostUrl: serverHostUrl || localHostUrl,
        token: serverToken || localToken,
      };
    }

    if (pref === "local") {
      return {
        hostUrl: localHostUrl || serverHostUrl,
        token: localToken || serverToken,
      };
    }

    if (localHostUrl) {
      return {
        hostUrl: localHostUrl,
        token: localToken || serverToken,
      };
    }

    return {
      hostUrl: serverHostUrl,
      token: serverToken || localToken,
    };
  };

  const resolveActiveBundleImportTarget = (): BundleImportTarget => {
    const active = options.workspaceStore.selectedWorkspaceDisplay();
    if (active.workspaceType === "local") {
      return { localRoot: options.workspaceStore.selectedWorkspaceRoot().trim() };
    }

    return {
      workspaceId:
        active.openworkWorkspaceId?.trim() ||
        parseOpenworkWorkspaceIdFromUrl(active.openworkHostUrl ?? "") ||
        parseOpenworkWorkspaceIdFromUrl(active.baseUrl ?? "") ||
        null,
      directoryHint: active.directory?.trim() || active.path?.trim() || null,
    };
  };

  const waitForBundleImportTarget = async (timeoutMs = 20_000, target?: BundleImportTarget) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const client = options.openworkServer.openworkServerClient();
      if (client && options.openworkServer.openworkServerStatus() === "connected") {
        if (target?.workspaceId?.trim() || target?.localRoot?.trim() || target?.directoryHint?.trim()) {
          try {
            const matchId = await options.workspaceStore.ensureRuntimeWorkspaceId({
              workspaceId: target.workspaceId,
              localRoot: target.localRoot,
              directoryHint: target.directoryHint,
              strictMatch: true,
            });
            if (matchId) {
              return { client, workspaceId: matchId };
            }
          } catch {
            // ignore and keep polling
          }
        } else {
          const workspaceId = options.runtimeWorkspaceId();
          if (workspaceId) {
            return { client, workspaceId };
          }
        }
      }
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 200);
      });
    }
    throw new Error("OpenWork worker is not ready yet.");
  };

  const importBundlePayload = async (bundle: BundleV1, target?: BundleImportTarget) => {
    const { client, workspaceId } = await waitForBundleImportTarget(20_000, target);
    const { payload, importedSkillsCount } = buildImportPayloadFromBundle(bundle);
    await client.importWorkspace(workspaceId, payload);
    await options.refreshActiveWorkspaceServerConfig(workspaceId);
    await options.refreshSkills({ force: true });
    await options.refreshHubSkills({ force: true });
    if (importedSkillsCount > 0) {
      options.markReloadRequired("skills", {
        type: "skill",
        name: bundle.name?.trim() || undefined,
        action: "added",
      });
    }
  };

  const importBundleIntoActiveWorker = async (
    request: BundleRequest,
    target?: BundleImportTarget,
    bundleOverride?: BundleV1,
    importOptions?: { allowUntrustedClientFetch?: boolean },
  ) => {
    try {
      const bundle =
        bundleOverride ??
        (await fetchBundle(request.bundleUrl?.trim() ?? "", options.openworkServer.openworkServerClient(), {
          forceClientFetch: importOptions?.allowUntrustedClientFetch,
        }));
      await importBundlePayload(bundle, target);
      options.setError(null);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      options.setError(addOpencodeCacheHint(message));
      return false;
    }
  };

  const createWorkerForBundle = async (request: BundleRequest, bundle: BundleV1) => {
    const target = resolveBundleWorkerTarget();
    const hostUrl = target.hostUrl.trim();
    const token = target.token.trim();
    if (!hostUrl || !token) {
      throw new Error("Bundle link detected. Configure an OpenWork worker host and token, then open the link again.");
    }

    const label = (request.label?.trim() || bundle.name?.trim() || t("app.shared_setup")).slice(0, 80);
    const ok = await options.workspaceStore.createRemoteWorkspaceFlow({
      openworkHostUrl: hostUrl,
      openworkToken: token,
      directory: null,
      displayName: label,
      manageBusy: false,
      closeModal: false,
    });

    if (!ok) {
      throw new Error("Failed to create a worker from this bundle.");
    }
  };

  const startWorkspaceFromBundle = async (folder: string | null) => {
    const request = bundleStartRequest();
    if (!request || bundleStartBusy()) return false;

    setBundleStartBusy(true);
    try {
      const ok = await options.workspaceStore.createWorkspaceFlow(request.defaultPreset, folder);
      if (!ok) return false;

      const imported = await importBundleIntoActiveWorker(
        request.request,
        {
          localRoot: options.workspaceStore.selectedWorkspaceRoot().trim(),
        },
        request.bundle,
      );
      if (!imported) return false;

      setBundleStartRequest(null);
      options.setError(null);
      return true;
    } finally {
      setBundleStartBusy(false);
    }
  };

  const createWorkspaceFromBundle = async (
    bundle: WorkspaceProfileBundleV1,
    folder: string | null,
    defaultPreset = defaultPresetFromWorkspaceProfileBundle(bundle),
  ) => {
    const request: BundleRequest = {
      intent: "new_worker",
      source: "team-template",
      label: bundle.name,
    };

    const ok = await options.workspaceStore.createWorkspaceFlow(defaultPreset, folder);
    if (!ok) return false;

    return importBundleIntoActiveWorker(
      request,
      {
        localRoot: options.workspaceStore.selectedWorkspaceRoot().trim(),
      },
      bundle,
    );
  };

  const importSkillIntoWorkspace = async (workspaceId: string) => {
    if (skillDestinationBusyId()) return;
    const destination = skillDestinationRequest();
    if (!destination) return;

    const workspace = options.workspaceStore.workspaces().find((item) => item.id === workspaceId) ?? null;
    if (!isBundleImportWorkspace(workspace)) {
      options.setError("This worker cannot accept imported skills yet.");
      return;
    }

    options.setView("settings");
    options.setSettingsTab("skills");
    options.setError(null);
    setSkillDestinationBusyId(workspaceId);

    try {
      const ok = await options.workspaceStore.activateWorkspace(workspaceId);
      if (!ok) return;

      const imported = await importBundleIntoActiveWorker(
        destination.request,
        resolveBundleImportTargetForWorkspace(workspace),
        destination.bundle,
      );
      if (!imported) return;

      showSkillSuccessToast({
        title: t("app.skill_added"),
        description: `Added '${destination.bundle.name.trim() || "Shared skill"}' to ${describeWorkspaceForBundleToasts(workspace)}.`,
      });
      setSkillDestinationRequest(null);
      setCreateWorkspaceRequest(null);
      setBundleNoticeShown(false);
    } finally {
      setSkillDestinationBusyId(null);
    }
  };

  const processBundleRequest = async (
    request: BundleRequest,
    processOptions?: { allowUntrustedClientFetch?: boolean },
  ): Promise<BundleProcessResult> => {
    if (maybeWarnAboutUntrustedBundle(request, processOptions)) {
      return { mode: "untrusted_warning" };
    }

    const bundle = await fetchBundle(request.bundleUrl?.trim() ?? "", options.openworkServer.openworkServerClient(), {
      forceClientFetch: processOptions?.allowUntrustedClientFetch,
    });

    if (bundle.type === "skill") {
      options.setView("settings");
      options.setSettingsTab("skills");
      options.setError(null);
      setSkillDestinationRequest({ request, bundle });
      return { mode: "choice", bundle };
    }

    if (bundle.type === "skills-set") {
      options.setView("settings");
      options.setSettingsTab("skills");
      options.setError(null);
      setBundleImportChoice({ request, bundle });
      return { mode: "choice", bundle };
    }

    if (request.intent === "new_worker" && isTauriRuntime()) {
      options.setView("settings");
      options.setSettingsTab("skills");
      options.setError(null);
      setCreateWorkspaceRequest(null);
      setBundleImportChoice(null);
      setBundleStartRequest({
        request,
        bundle,
        defaultPreset: defaultPresetFromWorkspaceProfileBundle(bundle),
      });
      return { mode: "start_modal", bundle };
    }

    if (request.intent === "import_current") {
      const client = options.openworkServer.openworkServerClient();
      const connected = options.openworkServer.openworkServerStatus() === "connected";
      const target = resolveActiveBundleImportTarget();
      const hasTargetHint = Boolean(target.workspaceId?.trim() || target.localRoot?.trim() || target.directoryHint?.trim());
      if (!client || !connected || !hasTargetHint) {
        if (!bundleNoticeShown()) {
          setBundleNoticeShown(true);
          options.setError("Bundle link detected. Connect to a writable OpenWork worker to import this bundle.");
        }
        return { mode: "blocked_import_current", bundle };
      }
    } else {
      const target = resolveBundleWorkerTarget();
      if (!target.hostUrl.trim() || !target.token.trim()) {
        if (!bundleNoticeShown()) {
          setBundleNoticeShown(true);
          options.setError("Bundle link detected. Configure an OpenWork host and token to create a new worker.");
        }
        return { mode: "blocked_new_worker", bundle };
      }
    }

    if (request.intent === "new_worker") {
      await createWorkerForBundle(request, bundle);
    }

    await importBundlePayload(bundle, resolveActiveBundleImportTarget());
    options.setError(null);
    return { mode: "imported", bundle };
  };

  createEffect(() => {
    const request = pendingBundleRequest();
    if (!request || options.booting()) {
      return;
    }

    if (untrack(bundleImportBusy)) {
      return;
    }

    let cancelled = false;
    setBundleImportBusy(true);

    void (async () => {
      try {
        await processBundleRequest(request);
        if (cancelled) return;
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : safeStringify(error);
          options.setError(addOpencodeCacheHint(message));
        }
      } finally {
        if (!cancelled) {
          const nextPendingRequest = pendingBundleRequest();
          const shouldClearPendingRequest = nextPendingRequest === request;
          setBundleImportBusy(false);
          if (shouldClearPendingRequest) {
            setPendingBundleRequest(null);
            setBundleNoticeShown(false);
          } else if (nextPendingRequest) {
            setPendingBundleRequest({ ...nextPendingRequest });
          }
        }
      }
    })();

    onCleanup(() => {
      cancelled = true;
    });
  });

  const queueBundleLink = (rawUrl: string): boolean => {
    const parsed = parseBundleDeepLink(rawUrl);
    if (!parsed) {
      return false;
    }
    setPendingBundleRequest(parsed);
    resetInteractiveBundleState();
    return true;
  };

  const openDebugBundleRequest = async (request: BundleRequest): Promise<{ ok: boolean; message: string }> => {
    setPendingBundleRequest(null);
    setBundleNoticeShown(false);
    resetInteractiveBundleState();
    options.setError(null);

    try {
      setBundleImportBusy(true);
      const result = await processBundleRequest(request);
      switch (result.mode) {
        case "choice":
          return { ok: true, message: "Opened the bundle import chooser." };
        case "start_modal":
          return { ok: true, message: "Opened the template start flow." };
        case "blocked_import_current":
        case "blocked_new_worker":
          return { ok: false, message: options.error() || "The bundle needs more worker setup before it can open." };
        case "untrusted_warning":
          return { ok: false, message: "Showed a security warning for an untrusted bundle link." };
        case "imported":
          return { ok: true, message: "Imported the bundle into the current worker." };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      const friendly = addOpencodeCacheHint(message);
      options.setError(friendly);
      return { ok: false, message: friendly };
    } finally {
      setBundleImportBusy(false);
    }
  };

  const closeBundleImportChoice = () => {
    if (bundleImportBusy()) return;
    setBundleImportChoice(null);
    setBundleImportError(null);
  };

  const dismissUntrustedBundleWarning = () => {
    if (bundleImportBusy()) return;
    setUntrustedBundleWarning(null);
  };

  const confirmUntrustedBundleWarning = async () => {
    const warning = untrustedBundleWarning();
    if (!warning || bundleImportBusy()) return;
    setUntrustedBundleWarning(null);
    setBundleImportError(null);
    options.setError(null);

    try {
      setBundleImportBusy(true);
      await processBundleRequest(warning.request, { allowUntrustedClientFetch: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      const friendly = addOpencodeCacheHint(message);
      options.setError(friendly);
    } finally {
      setBundleImportBusy(false);
    }
  };

  const openTeamBundle = async (input: {
    templateId?: string;
    name: string;
    templateData: unknown;
    organizationName?: string | null;
  }) => {
    const bundle = parseBundlePayload(input.templateData);
    options.setError(null);
    options.setView("settings");
    options.setSettingsTab("general");
    setSkillDestinationBusyId(null);
    setBundleImportError(null);
    setBundleStartRequest(null);
    setCreateWorkspaceRequest(null);

    if (bundle.type === "skill") {
      setBundleImportChoice(null);
      setSkillDestinationRequest({
        request: {
          intent: "import_current",
          source: "team-template",
          label: input.name,
        },
        bundle,
      });
      return;
    }

    setSkillDestinationRequest(null);
    setBundleImportChoice({
      request: {
        intent: "import_current",
        source: "team-template",
        label: input.name,
      },
      bundle,
    });
  };

  const startWorkspaceFromTeamTemplate = async (input: {
    name: string;
    templateData: unknown;
    folder: string | null;
    preset?: WorkspacePreset;
  }) => {
    const bundle = parseBundlePayload(input.templateData);
    if (bundle.type !== "workspace-profile") {
      throw new Error("Only workspace templates can start a new workspace.");
    }

    options.setError(null);
    setSkillDestinationRequest(null);
    setBundleImportChoice(null);
    setBundleImportError(null);
    setCreateWorkspaceRequest(null);
    setBundleStartRequest(null);

    const imported = await createWorkspaceFromBundle(
      bundle,
      input.folder,
      input.preset ?? defaultPresetFromWorkspaceProfileBundle(bundle),
    );
    if (!imported) {
      throw new Error(`Failed to create ${input.name} from template.`);
    }
  };

  const bundleImportSummary = createMemo<BundleImportSummary | null>(() => {
    const choice = bundleImportChoice();
    return choice ? describeBundleImport(choice.bundle) : null;
  });

  const bundleStartItems = createMemo(() => {
    const request = bundleStartRequest();
    return request ? describeBundleImport(request.bundle).items : [];
  });

  const createWorkspaceDefaultPreset = createMemo<WorkspacePreset>(() => createWorkspaceRequest()?.defaultPreset ?? "starter");

  const skillDestinationWorkspaces = createMemo(() => {
    const activeId = options.workspaceStore.selectedWorkspaceId();
    return options.workspaceStore
      .workspaces()
      .filter((workspace) => isBundleImportWorkspace(workspace))
      .slice()
      .sort((a, b) => {
        if (a.id === activeId && b.id !== activeId) return -1;
        if (b.id === activeId && a.id !== activeId) return 1;
        const aLabel =
          a.displayName?.trim() ||
          a.openworkWorkspaceName?.trim() ||
          a.name?.trim() ||
          a.directory?.trim() ||
          a.path?.trim() ||
          a.baseUrl?.trim() ||
          "";
        const bLabel =
          b.displayName?.trim() ||
          b.openworkWorkspaceName?.trim() ||
          b.name?.trim() ||
          b.directory?.trim() ||
          b.path?.trim() ||
          b.baseUrl?.trim() ||
          "";
        return aLabel.localeCompare(bLabel, undefined, { sensitivity: "base" });
      });
  });

  const bundleWorkerOptions = createMemo<BundleWorkerOption[]>(() => {
    const selectedWorkspaceId = options.workspaceStore.selectedWorkspaceId().trim();
    const items = options.workspaceStore.workspaces().map((workspace) => {
      let disabledReason: string | null = null;
      if (!resolveBundleImportTargetForWorkspace(workspace)) {
        disabledReason =
          workspace.workspaceType === "remote" && workspace.remoteType !== "openwork"
            ? "Only OpenWork-connected workers support direct bundle imports."
            : "This worker is missing the info OpenWork needs to import the bundle.";
      }

      const label =
        workspace.displayName?.trim() ||
        workspace.openworkWorkspaceName?.trim() ||
        workspace.name?.trim() ||
        workspace.path?.trim() ||
        t("app.worker_fallback");
      const badge =
        workspace.workspaceType === "remote"
          ? workspace.sandboxBackend === "docker" ||
            Boolean(workspace.sandboxRunId?.trim()) ||
            Boolean(workspace.sandboxContainerName?.trim())
            ? t("workspace.sandbox_badge")
            : t("workspace.remote_badge")
          : t("workspace.local_badge");
      const detail =
        workspace.workspaceType === "local"
          ? workspace.path?.trim() || t("app.local_worker_detail")
          : workspace.directory?.trim() || workspace.baseUrl?.trim() || workspace.openworkHostUrl?.trim() || t("app.remote_worker_detail");

      return {
        id: workspace.id,
        label,
        detail,
        badge,
        current: workspace.id === selectedWorkspaceId,
        disabledReason,
      } satisfies BundleWorkerOption;
    });

    return items.sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  });

  const openCreateWorkspaceFromChoice = async () => {
    const choice = bundleImportChoice();
    if (!choice || bundleImportBusy()) return;

    setBundleImportError(null);
    options.setError(null);

    if (isTauriRuntime()) {
      options.setView("settings");
      options.setSettingsTab("skills");
      setCreateWorkspaceRequest({
        request: choice.request,
        bundle: choice.bundle,
        defaultPreset: choice.bundle.type === "workspace-profile" ? defaultPresetFromWorkspaceProfileBundle(choice.bundle) : "starter",
      });
      setBundleImportChoice(null);
      options.workspaceStore.setCreateWorkspaceOpen(true);
      return;
    }

    setBundleImportBusy(true);
    try {
      await createWorkerForBundle(choice.request, choice.bundle);
      await importBundlePayload(choice.bundle, resolveActiveBundleImportTarget());
      setBundleImportChoice(null);
      options.setError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      const friendly = addOpencodeCacheHint(message);
      setBundleImportError(friendly);
      options.setError(friendly);
    } finally {
      setBundleImportBusy(false);
    }
  };

  const importBundleIntoExistingWorkspace = async (workspaceId: string) => {
    const choice = bundleImportChoice();
    if (!choice || bundleImportBusy()) return;

    const workspace = options.workspaceStore.workspaces().find((item) => item.id === workspaceId) ?? null;
    if (!workspace) {
      setBundleImportError("The selected worker is no longer available.");
      return;
    }

    const target = resolveBundleImportTargetForWorkspace(workspace);
    if (!target) {
      setBundleImportError("This worker cannot accept bundle imports yet.");
      return;
    }

    setBundleImportBusy(true);
    setBundleImportError(null);
    options.setError(null);

    try {
      options.setView("settings");
      options.setSettingsTab(choice.bundle.type === "workspace-profile" ? "general" : "skills");
      const ok = await options.workspaceStore.activateWorkspace(workspace.id);
      if (!ok) {
        throw new Error(options.error() || `Failed to switch to ${workspace.displayName?.trim() || workspace.name || "the selected worker"}.`);
      }
      await importBundlePayload(choice.bundle, target);
      setBundleImportChoice(null);
      options.setError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      const friendly = addOpencodeCacheHint(message);
      setBundleImportError(friendly);
      options.setError(friendly);
    } finally {
      setBundleImportBusy(false);
    }
  };

  const openCreateWorkspaceFromSkillDestination = () => {
    const request = skillDestinationRequest();
    if (!request) return;
    options.setError(null);
    setCreateWorkspaceRequest({
      request: request.request,
      bundle: request.bundle,
      defaultPreset: "minimal",
    });
    options.workspaceStore.setCreateWorkspaceOpen(true);
  };

  const openRemoteConnectFromSkillDestination = () => {
    options.setError(null);
    options.workspaceStore.setCreateRemoteWorkspaceOpen(true);
  };

  const handleCreateWorkspaceConfirm = async (preset: WorkspacePreset, folder: string | null) => {
    const request = createWorkspaceRequest();
    const ok = await options.workspaceStore.createWorkspaceFlow(preset, folder);
    if (!ok || !request) return;

    const imported = await importBundleIntoActiveWorker(
      request.request,
      {
        localRoot: options.workspaceStore.selectedWorkspaceRoot().trim(),
      },
      request.bundle,
    );
    setCreateWorkspaceRequest(null);
    if (imported) {
      if (request.bundle.type === "skill") {
        showSkillSuccessToast({
          title: t("app.skill_added"),
          description: `Added '${request.bundle.name.trim() || "Shared skill"}' to ${describeWorkspaceForBundleToasts(options.workspaceStore.selectedWorkspaceDisplay())}.`,
        });
      }
      setSkillDestinationRequest(null);
    }
  };

  const handleCreateSandboxConfirm = async (preset: WorkspacePreset, folder: string | null) => {
    const request = createWorkspaceRequest();
    const ok = await options.workspaceStore.createSandboxFlow(
      preset,
      folder,
      request
        ? {
            onReady: async () => {
              const active = options.workspaceStore.selectedWorkspaceDisplay();
              await importBundleIntoActiveWorker(
                request.request,
                {
                  workspaceId:
                    active.openworkWorkspaceId?.trim() ||
                    parseOpenworkWorkspaceIdFromUrl(active.openworkHostUrl ?? "") ||
                    parseOpenworkWorkspaceIdFromUrl(active.baseUrl ?? "") ||
                    null,
                  directoryHint: active.directory?.trim() || active.path?.trim() || null,
                },
                request.bundle,
              );
              if (request.bundle.type === "skill") {
                showSkillSuccessToast({
                  title: t("app.skill_added"),
                  description: `Added '${request.bundle.name.trim() || "Shared skill"}' to ${describeWorkspaceForBundleToasts(active)}.`,
                });
              }
            },
          }
        : undefined,
    );
    if (!ok) return;
    setCreateWorkspaceRequest(null);
    if (request) {
      setSkillDestinationRequest(null);
    }
  };

  return {
    queueBundleLink,
    openDebugBundleRequest,
    openTeamBundle,
    startWorkspaceFromTeamTemplate,
    closeBundleImportChoice,
    openCreateWorkspaceFromChoice,
    importBundleIntoExistingWorkspace,
    clearBundleStartRequest: () => {
      if (bundleStartBusy()) return;
      setBundleStartRequest(null);
    },
    startWorkspaceFromBundle,
    clearCreateWorkspaceRequest: () => setCreateWorkspaceRequest(null),
    clearSkillDestinationRequest: () => {
      if (skillDestinationBusyId()) return;
      setSkillDestinationRequest(null);
    },
    importSkillIntoWorkspace,
    openCreateWorkspaceFromSkillDestination,
    openRemoteConnectFromSkillDestination,
    handleCreateWorkspaceConfirm,
    handleCreateSandboxConfirm,
    dismissUntrustedBundleWarning,
    confirmUntrustedBundleWarning,
    bundleImportChoice,
    bundleImportSummary,
    bundleWorkerOptions,
    bundleImportBusy,
    bundleImportError,
    bundleStartRequest,
    bundleStartItems,
    bundleStartBusy,
    createWorkspaceRequest,
    createWorkspaceDefaultPreset,
    untrustedBundleWarning,
    skillDestinationRequest,
    skillDestinationWorkspaces,
    skillDestinationBusyId,
  };
}
