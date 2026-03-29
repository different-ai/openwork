import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
  type Accessor,
} from "solid-js";

import type { OpenworkServerInfo, WorkspaceInfo } from "../lib/tauri";
import type {
  OpenworkServerClient,
  OpenworkServerSettings,
  OpenworkServerStatus,
} from "../lib/openwork-server";
import {
  buildImportPayloadFromBundle,
  defaultPresetFromTemplateBundle,
  describeSharedBundleImport,
  fetchSharedBundle,
  parseSharedBundle,
  parseSharedBundleDeepLink,
  type SharedBundleDeepLink,
  type SharedBundleV1,
  type SharedSkillBundleV1,
  type SharedWorkspaceProfileBundleV1,
} from "../lib/shared-bundles";
import type {
  DashboardTab,
  ReloadReason,
  ReloadTrigger,
  StartupPreference,
  View,
  WorkspaceDisplay,
  WorkspacePreset,
} from "../types";
import { addOpencodeCacheHint, isTauriRuntime, safeStringify } from "../utils";
import { normalizeOpenworkServerUrl, parseOpenworkWorkspaceIdFromUrl } from "../lib/openwork-server";
import type { WorkspaceStore } from "./workspace";

type SharedBundleCreateWorkerRequest = {
  request: SharedBundleDeepLink;
  bundle: SharedBundleV1;
  defaultPreset: WorkspacePreset;
};

type SharedTemplateStartRequest = {
  request: SharedBundleDeepLink;
  bundle: SharedWorkspaceProfileBundleV1;
  defaultPreset: WorkspacePreset;
};

type SharedSkillDestinationRequest = {
  request: SharedBundleDeepLink;
  bundle: SharedSkillBundleV1;
};

type SharedSkillSuccessToast = {
  title: string;
  description: string;
};

type SharedBundleImportTarget = {
  workspaceId?: string | null;
  localRoot?: string | null;
  directoryHint?: string | null;
};

type SharedBundleImportChoice = {
  request: SharedBundleDeepLink;
  bundle: SharedBundleV1;
};

type SharedBundleWorkerOption = {
  id: string;
  label: string;
  detail: string;
  badge: string;
  current: boolean;
  disabledReason: string | null;
};

export function createSharedBundleFlow(options: {
  booting: Accessor<boolean>;
  startupPreference: Accessor<StartupPreference | null>;
  openworkServerHostInfo: Accessor<OpenworkServerInfo | null>;
  openworkServerSettings: Accessor<OpenworkServerSettings>;
  openworkServerClient: Accessor<OpenworkServerClient | null>;
  openworkServerStatus: Accessor<OpenworkServerStatus>;
  runtimeWorkspaceId: Accessor<string | null>;
  workspaceStore: WorkspaceStore;
  error: Accessor<string | null>;
  setError: (value: string | null) => void;
  setView: (next: View, sessionId?: string) => void;
  setTab: (nextTab: DashboardTab) => void;
  refreshActiveWorkspaceServerConfig: (workspaceId: string) => Promise<unknown>;
  refreshSkills: (options?: { force?: boolean }) => Promise<void>;
  refreshHubSkills: (options?: { force?: boolean }) => Promise<void>;
  markReloadRequired: (reason: ReloadReason, trigger?: ReloadTrigger) => void;
}) {
  const [pendingSharedBundleInvite, setPendingSharedBundleInvite] = createSignal<SharedBundleDeepLink | null>(null);
  const [sharedTemplateStartRequest, setSharedTemplateStartRequest] =
    createSignal<SharedTemplateStartRequest | null>(null);
  const [sharedTemplateStartBusy, setSharedTemplateStartBusy] = createSignal(false);
  const [sharedBundleCreateWorkerRequest, setSharedBundleCreateWorkerRequest] =
    createSignal<SharedBundleCreateWorkerRequest | null>(null);
  const [sharedSkillDestinationRequest, setSharedSkillDestinationRequest] =
    createSignal<SharedSkillDestinationRequest | null>(null);
  const [sharedSkillDestinationBusyId, setSharedSkillDestinationBusyId] = createSignal<string | null>(null);
  const [sharedBundleImportChoice, setSharedBundleImportChoice] = createSignal<SharedBundleImportChoice | null>(null);
  const [sharedBundleImportBusy, setSharedBundleImportBusy] = createSignal(false);
  const [sharedBundleImportError, setSharedBundleImportError] = createSignal<string | null>(null);
  const [sharedBundleNoticeShown, setSharedBundleNoticeShown] = createSignal(false);
  const [sharedSkillSuccessToast, setSharedSkillSuccessToast] = createSignal<SharedSkillSuccessToast | null>(null);

  let sharedSkillSuccessToastTimer: number | null = null;

  const clearSharedSkillSuccessToast = () => {
    if (sharedSkillSuccessToastTimer) {
      window.clearTimeout(sharedSkillSuccessToastTimer);
      sharedSkillSuccessToastTimer = null;
    }
    setSharedSkillSuccessToast(null);
  };

  const showSharedSkillSuccessToast = (toast: SharedSkillSuccessToast) => {
    if (sharedSkillSuccessToastTimer) {
      window.clearTimeout(sharedSkillSuccessToastTimer);
    }
    setSharedSkillSuccessToast(toast);
    sharedSkillSuccessToastTimer = window.setTimeout(() => {
      sharedSkillSuccessToastTimer = null;
      setSharedSkillSuccessToast(null);
    }, 4200);
  };

  onCleanup(() => {
    if (sharedSkillSuccessToastTimer) {
      window.clearTimeout(sharedSkillSuccessToastTimer);
    }
  });

  const createWorkspaceDefaultPreset = createMemo<WorkspacePreset>(() =>
    sharedBundleCreateWorkerRequest()?.defaultPreset ?? "starter"
  );

  const sharedTemplateStartItems = createMemo(() => {
    const request = sharedTemplateStartRequest();
    return request ? describeSharedBundleImport(request.bundle).items : [];
  });

  const isSharedBundleImportWorkspace = (workspace: WorkspaceDisplay | WorkspaceInfo | null) => {
    if (!workspace?.id?.trim()) return false;
    if (workspace.workspaceType === "local") {
      return Boolean(workspace.path?.trim());
    }
    return Boolean(
      workspace.remoteType === "openwork" ||
        workspace.openworkHostUrl?.trim() ||
        workspace.openworkWorkspaceId?.trim()
    );
  };

  const sharedSkillDestinationWorkspaces = createMemo(() => {
    const activeId = options.workspaceStore.selectedWorkspaceId();
    return options.workspaceStore
      .workspaces()
      .filter((workspace) => isSharedBundleImportWorkspace(workspace))
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

  const describeWorkspaceForToasts = (workspace: WorkspaceDisplay | WorkspaceInfo | null) =>
    workspace?.displayName?.trim() ||
    workspace?.openworkWorkspaceName?.trim() ||
    workspace?.name?.trim() ||
    workspace?.directory?.trim() ||
    workspace?.path?.trim() ||
    workspace?.baseUrl?.trim() ||
    "the selected worker";

  const resolveSharedBundleImportTargetForWorkspace = (
    workspace: WorkspaceDisplay | WorkspaceInfo | null,
  ): SharedBundleImportTarget | undefined => {
    if (!workspace) return undefined;
    if (workspace.workspaceType === "local") {
      const localRoot = workspace.path?.trim() ?? "";
      return localRoot ? { localRoot } : undefined;
    }

    const workspaceId =
      workspace.openworkWorkspaceId?.trim() ||
      parseOpenworkWorkspaceIdFromUrl(workspace.openworkHostUrl ?? "") ||
      parseOpenworkWorkspaceIdFromUrl(workspace.baseUrl ?? "") ||
      null;
    const directoryHint = workspace.directory?.trim() || workspace.path?.trim() || null;
    if (workspaceId || directoryHint) {
      return {
        workspaceId,
        directoryHint,
      };
    }
    return undefined;
  };

  const resolveActiveSharedBundleImportTarget = (): SharedBundleImportTarget => {
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

  const resolveSharedBundleWorkerTarget = () => {
    const pref = options.startupPreference();
    const hostInfo = options.openworkServerHostInfo();
    const settings = options.openworkServerSettings();

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

  const waitForSharedBundleImportTarget = async (timeoutMs = 20_000, target?: SharedBundleImportTarget) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const client = options.openworkServerClient();
      if (client && options.openworkServerStatus() === "connected") {
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

  const importSharedBundlePayload = async (bundle: SharedBundleV1, target?: SharedBundleImportTarget) => {
    const { client, workspaceId } = await waitForSharedBundleImportTarget(20_000, target);
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
      console.log(`[openwork] imported ${importedSkillsCount} skills from share bundle`);
    }
  };

  const importSharedBundleIntoActiveWorker = async (
    request: SharedBundleDeepLink,
    target?: SharedBundleImportTarget,
    bundleOverride?: SharedBundleV1,
  ) => {
    try {
      const bundle = bundleOverride ?? (await fetchSharedBundle(request.bundleUrl, options.openworkServerClient()));
      await importSharedBundlePayload(bundle, target);
      options.setError(null);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      options.setError(addOpencodeCacheHint(message));
      return false;
    }
  };

  const createWorkerForSharedBundle = async (request: SharedBundleDeepLink, bundle: SharedBundleV1) => {
    const target = resolveSharedBundleWorkerTarget();
    const hostUrl = target.hostUrl.trim();
    const token = target.token.trim();
    if (!hostUrl || !token) {
      throw new Error("Share link detected. Configure an OpenWork worker host and token, then open the link again.");
    }

    const label = (request.label?.trim() || bundle.name?.trim() || "Shared setup").slice(0, 80);
    const ok = await options.workspaceStore.createRemoteWorkspaceFlow({
      openworkHostUrl: hostUrl,
      openworkToken: token,
      directory: null,
      displayName: label,
      manageBusy: false,
      closeModal: false,
    });

    if (!ok) {
      throw new Error("Failed to create a worker from this share link.");
    }
  };

  const startWorkspaceFromTemplate = async (folder: string | null) => {
    const request = sharedTemplateStartRequest();
    if (!request || sharedTemplateStartBusy()) return false;

    setSharedTemplateStartBusy(true);

    try {
      const ok = await options.workspaceStore.createWorkspaceFlow(request.defaultPreset, folder);
      if (!ok) return false;

      const imported = await importSharedBundleIntoActiveWorker(
        request.request,
        {
          localRoot: options.workspaceStore.selectedWorkspaceRoot().trim(),
        },
        request.bundle,
      );

      if (!imported) return false;

      setSharedTemplateStartRequest(null);
      options.setError(null);
      return true;
    } finally {
      setSharedTemplateStartBusy(false);
    }
  };

  const createWorkspaceFromBundle = async (
    bundle: SharedWorkspaceProfileBundleV1,
    folder: string | null,
    defaultPreset = defaultPresetFromTemplateBundle(bundle),
  ) => {
    const request = {
      bundleUrl: "",
      intent: "new_worker" as const,
      source: "cloud-template" as const,
      label: bundle.name,
    };

    const ok = await options.workspaceStore.createWorkspaceFlow(defaultPreset, folder);
    if (!ok) return false;

    return importSharedBundleIntoActiveWorker(
      request,
      {
        localRoot: options.workspaceStore.selectedWorkspaceRoot().trim(),
      },
      bundle,
    );
  };

  const importSharedSkillIntoWorkspace = async (workspaceId: string) => {
    if (sharedSkillDestinationBusyId()) return;
    const destination = sharedSkillDestinationRequest();
    if (!destination) return;

    const workspace = options.workspaceStore.workspaces().find((item) => item.id === workspaceId) ?? null;
    if (!isSharedBundleImportWorkspace(workspace)) {
      options.setError("This worker cannot accept shared skills yet.");
      return;
    }

    options.setView("dashboard");
    options.setTab("scheduled");
    options.setError(null);
    setSharedSkillDestinationBusyId(workspaceId);

    try {
      const ok = await options.workspaceStore.activateWorkspace(workspaceId);
      if (!ok) return;

      const imported = await importSharedBundleIntoActiveWorker(
        destination.request,
        resolveSharedBundleImportTargetForWorkspace(workspace),
        destination.bundle,
      );
      if (!imported) return;

      showSharedSkillSuccessToast({
        title: "Skill added",
        description: `Added '${destination.bundle.name.trim() || "Shared skill"}' to ${describeWorkspaceForToasts(workspace)}.`,
      });
      setSharedSkillDestinationRequest(null);
      setSharedBundleCreateWorkerRequest(null);
      setSharedBundleNoticeShown(false);
    } finally {
      setSharedSkillDestinationBusyId(null);
    }
  };

  const processSharedBundleInvite = async (request: SharedBundleDeepLink) => {
    const bundle = await fetchSharedBundle(request.bundleUrl, options.openworkServerClient());

    if (bundle.type === "skill") {
      options.setView("dashboard");
      options.setTab("scheduled");
      options.setError(null);
      setSharedSkillDestinationRequest({ request, bundle });
      return { mode: "choice" as const, bundle };
    }

    if (bundle.type === "skills-set") {
      options.setView("dashboard");
      options.setTab("skills");
      options.setError(null);
      setSharedBundleImportChoice({ request, bundle });
      return { mode: "choice" as const, bundle };
    }

    if (bundle.type === "workspace-profile" && request.intent === "new_worker" && isTauriRuntime()) {
      options.setView("dashboard");
      options.setTab("scheduled");
      options.setError(null);
      setSharedBundleCreateWorkerRequest(null);
      setSharedBundleImportChoice(null);
      setSharedTemplateStartRequest({
        request,
        bundle,
        defaultPreset: defaultPresetFromTemplateBundle(bundle),
      });
      return { mode: "start_with_template_modal" as const, bundle };
    }

    if (request.intent === "import_current") {
      const client = options.openworkServerClient();
      const connected = options.openworkServerStatus() === "connected";
      const target = resolveActiveSharedBundleImportTarget();
      const hasTargetHint = Boolean(
        target.workspaceId?.trim() || target.localRoot?.trim() || target.directoryHint?.trim()
      );
      if (!client || !connected || !hasTargetHint) {
        if (!sharedBundleNoticeShown()) {
          setSharedBundleNoticeShown(true);
          options.setError("Share link detected. Connect to a writable OpenWork worker to import this bundle.");
        }
        return { mode: "blocked_import_current" as const, bundle };
      }
    } else {
      const target = resolveSharedBundleWorkerTarget();
      if (!target.hostUrl.trim() || !target.token.trim()) {
        if (!sharedBundleNoticeShown()) {
          setSharedBundleNoticeShown(true);
          options.setError("Share link detected. Configure an OpenWork host and token to create a new worker.");
        }
        return { mode: "blocked_new_worker" as const, bundle };
      }
    }

    if (request.intent === "new_worker") {
      await createWorkerForSharedBundle(request, bundle);
    }

    await importSharedBundlePayload(bundle, resolveActiveSharedBundleImportTarget());
    options.setError(null);
    return { mode: "imported" as const, bundle };
  };

  createEffect(() => {
    const request = pendingSharedBundleInvite();
    if (!request || options.booting()) {
      return;
    }

    if (untrack(sharedBundleImportBusy)) {
      return;
    }

    let cancelled = false;
    setSharedBundleImportBusy(true);

    void (async () => {
      try {
        await processSharedBundleInvite(request);
        if (cancelled) return;
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : safeStringify(error);
          options.setError(addOpencodeCacheHint(message));
        }
      } finally {
        if (!cancelled) {
          const nextPendingInvite = pendingSharedBundleInvite();
          const shouldClearPendingInvite = nextPendingInvite === request;
          setSharedBundleImportBusy(false);
          if (shouldClearPendingInvite) {
            setPendingSharedBundleInvite(null);
            setSharedBundleNoticeShown(false);
          } else if (nextPendingInvite) {
            setPendingSharedBundleInvite({ ...nextPendingInvite });
          }
        }
      }
    })();

    onCleanup(() => {
      cancelled = true;
    });
  });

  const queueSharedBundleInvite = (invite: SharedBundleDeepLink) => {
    setPendingSharedBundleInvite(invite);
    setSharedSkillDestinationRequest(null);
    setSharedSkillDestinationBusyId(null);
    setSharedBundleImportChoice(null);
    setSharedBundleCreateWorkerRequest(null);
    setSharedBundleImportError(null);
    setSharedBundleNoticeShown(false);
  };

  const queueSharedBundleDeepLink = (rawUrl: string): boolean => {
    const parsed = parseSharedBundleDeepLink(rawUrl);
    if (!parsed) {
      return false;
    }
    queueSharedBundleInvite(parsed);
    return true;
  };

  const openDebugSharedBundleLink = async (
    request: SharedBundleDeepLink,
  ): Promise<{ ok: boolean; message: string }> => {
    setPendingSharedBundleInvite(null);
    setSharedBundleNoticeShown(false);
    setSharedSkillDestinationRequest(null);
    setSharedSkillDestinationBusyId(null);
    setSharedBundleImportError(null);
    setSharedBundleImportChoice(null);
    setSharedTemplateStartRequest(null);
    setSharedBundleCreateWorkerRequest(null);

    try {
      setSharedBundleImportBusy(true);
      const result = await processSharedBundleInvite(request);
      switch (result.mode) {
        case "choice":
          return { ok: true, message: "Opened the share import chooser." };
        case "start_with_template_modal":
          return { ok: true, message: "Opened the template start flow." };
        case "blocked_import_current":
        case "blocked_new_worker":
          return {
            ok: false,
            message: options.error() || "The share link needs more worker setup before it can open.",
          };
        case "imported":
          return { ok: true, message: "Imported the shared bundle into the current worker." };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      const friendly = addOpencodeCacheHint(message);
      options.setError(friendly);
      return { ok: false, message: friendly };
    } finally {
      setSharedBundleImportBusy(false);
    }
  };

  const closeSharedBundleImportChoice = () => {
    if (sharedBundleImportBusy()) return;
    setSharedBundleImportChoice(null);
    setSharedBundleImportError(null);
  };

  const openCloudTemplate = async (input: {
    templateId: string;
    name: string;
    templateData: unknown;
    organizationName?: string | null;
  }) => {
    const bundle = parseSharedBundle(input.templateData);
    options.setError(null);
    options.setView("dashboard");
    options.setTab("settings");
    setSharedSkillDestinationBusyId(null);
    setSharedBundleImportError(null);
    setSharedTemplateStartRequest(null);
    setSharedBundleCreateWorkerRequest(null);

    if (bundle.type === "skill") {
      setSharedBundleImportChoice(null);
      setSharedSkillDestinationRequest({
        request: {
          bundleUrl: "",
          intent: "import_current",
          source: "cloud-template",
          label: input.name,
        },
        bundle,
      });
      return;
    }

    setSharedSkillDestinationRequest(null);
    setSharedBundleImportChoice({
      request: {
        bundleUrl: "",
        intent: "import_current",
        source: "cloud-template",
        label: input.name,
      },
      bundle,
    });
  };

  const startWorkspaceFromCloudTemplate = async (input: {
    name: string;
    templateData: unknown;
    folder: string | null;
    preset?: WorkspacePreset;
  }) => {
    const bundle = parseSharedBundle(input.templateData);
    if (bundle.type !== "workspace-profile") {
      throw new Error("Only workspace templates can start a new workspace.");
    }

    options.setError(null);
    setSharedSkillDestinationRequest(null);
    setSharedBundleImportChoice(null);
    setSharedBundleImportError(null);
    setSharedBundleCreateWorkerRequest(null);
    setSharedTemplateStartRequest(null);

    const imported = await createWorkspaceFromBundle(
      bundle,
      input.folder,
      input.preset ?? defaultPresetFromTemplateBundle(bundle),
    );
    if (!imported) {
      throw new Error(`Failed to create ${input.name} from template.`);
    }
  };

  const sharedBundleImportCopy = createMemo(() => {
    const choice = sharedBundleImportChoice();
    if (!choice) return null;
    return describeSharedBundleImport(choice.bundle);
  });

  const sharedBundleWorkerOptions = createMemo<SharedBundleWorkerOption[]>(() => {
    const selectedWorkspaceId = options.workspaceStore.selectedWorkspaceId().trim();
    const items = options.workspaceStore.workspaces().map((workspace) => {
      let disabledReason: string | null = null;
      if (!resolveSharedBundleImportTargetForWorkspace(workspace)) {
        disabledReason =
          workspace.workspaceType === "remote" && workspace.remoteType !== "openwork"
            ? "Only OpenWork-connected workers support direct shared bundle imports."
            : "This worker is missing the info OpenWork needs to import the bundle.";
      }

      const label =
        workspace.displayName?.trim() ||
        workspace.openworkWorkspaceName?.trim() ||
        workspace.name?.trim() ||
        workspace.path?.trim() ||
        "Worker";
      const badge =
        workspace.workspaceType === "remote"
          ? workspace.sandboxBackend === "docker" ||
            Boolean(workspace.sandboxRunId?.trim()) ||
            Boolean(workspace.sandboxContainerName?.trim())
            ? "Sandbox"
            : "Remote"
          : "Local";
      const detail =
        workspace.workspaceType === "local"
          ? workspace.path?.trim() || "Local worker"
          : workspace.directory?.trim() ||
            workspace.baseUrl?.trim() ||
            workspace.openworkHostUrl?.trim() ||
            "Remote worker";

      return {
        id: workspace.id,
        label,
        detail,
        badge,
        current: workspace.id === selectedWorkspaceId,
        disabledReason,
      };
    });

    return items.sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  });

  const openSharedBundleCreateWorkerFlow = async () => {
    const choice = sharedBundleImportChoice();
    if (!choice || sharedBundleImportBusy()) return;

    setSharedBundleImportError(null);
    options.setError(null);

    if (isTauriRuntime()) {
      options.setView("dashboard");
      options.setTab("scheduled");
      setSharedBundleCreateWorkerRequest({
        request: choice.request,
        bundle: choice.bundle,
        defaultPreset:
          choice.bundle.type === "workspace-profile"
            ? defaultPresetFromTemplateBundle(choice.bundle)
            : "starter",
      });
      setSharedBundleImportChoice(null);
      options.workspaceStore.setCreateWorkspaceOpen(true);
      return;
    }

    setSharedBundleImportBusy(true);
    try {
      await createWorkerForSharedBundle(choice.request, choice.bundle);
      await importSharedBundlePayload(choice.bundle, resolveActiveSharedBundleImportTarget());
      setSharedBundleImportChoice(null);
      options.setError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      const friendly = addOpencodeCacheHint(message);
      setSharedBundleImportError(friendly);
      options.setError(friendly);
    } finally {
      setSharedBundleImportBusy(false);
    }
  };

  const importSharedBundleIntoExistingWorkspace = async (workspaceId: string) => {
    const choice = sharedBundleImportChoice();
    if (!choice || sharedBundleImportBusy()) return;

    const workspace = options.workspaceStore.workspaces().find((item) => item.id === workspaceId) ?? null;
    if (!workspace) {
      setSharedBundleImportError("The selected worker is no longer available.");
      return;
    }

    const target = resolveSharedBundleImportTargetForWorkspace(workspace);
    if (!target) {
      setSharedBundleImportError("This worker cannot accept shared bundle imports yet.");
      return;
    }

    setSharedBundleImportBusy(true);
    setSharedBundleImportError(null);
    options.setError(null);

    try {
      options.setView("dashboard");
      options.setTab(choice.bundle.type === "workspace-profile" ? "scheduled" : "skills");
      const ok = await options.workspaceStore.activateWorkspace(workspace.id);
      if (!ok) {
        throw new Error(
          options.error() ||
            `Failed to switch to ${workspace.displayName?.trim() || workspace.name || "the selected worker"}.`,
        );
      }
      await importSharedBundlePayload(choice.bundle, target);
      setSharedBundleImportChoice(null);
      options.setError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      const friendly = addOpencodeCacheHint(message);
      setSharedBundleImportError(friendly);
      options.setError(friendly);
    } finally {
      setSharedBundleImportBusy(false);
    }
  };

  const closeTemplateStart = () => {
    if (sharedTemplateStartBusy()) return;
    setSharedTemplateStartRequest(null);
  };

  const clearSharedBundleCreateWorkerRequest = () => {
    setSharedBundleCreateWorkerRequest(null);
  };

  const confirmCreateWorkspaceImport = async (preset: WorkspacePreset, folder: string | null) => {
    const request = sharedBundleCreateWorkerRequest();
    const ok = await options.workspaceStore.createWorkspaceFlow(preset, folder);
    if (!ok || !request) return;
    const imported = await importSharedBundleIntoActiveWorker(
      request.request,
      {
        localRoot: options.workspaceStore.selectedWorkspaceRoot().trim(),
      },
      request.bundle,
    );
    setSharedBundleCreateWorkerRequest(null);
    if (imported) {
      if (request.bundle.type === "skill") {
        showSharedSkillSuccessToast({
          title: "Skill added",
          description: `Added '${request.bundle.name.trim() || "Shared skill"}' to ${describeWorkspaceForToasts(options.workspaceStore.selectedWorkspaceDisplay())}.`,
        });
      }
      setSharedSkillDestinationRequest(null);
    }
  };

  const confirmCreateSandboxImport = async (preset: WorkspacePreset, folder: string | null) => {
    const request = sharedBundleCreateWorkerRequest();
    const ok = await options.workspaceStore.createSandboxFlow(
      preset,
      folder,
      request
        ? {
            onReady: async () => {
              const active = options.workspaceStore.selectedWorkspaceDisplay();
              await importSharedBundleIntoActiveWorker(
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
                showSharedSkillSuccessToast({
                  title: "Skill added",
                  description: `Added '${request.bundle.name.trim() || "Shared skill"}' to ${describeWorkspaceForToasts(active)}.`,
                });
              }
            },
          }
        : undefined,
    );
    if (!ok) return;
    setSharedBundleCreateWorkerRequest(null);
    if (request) {
      setSharedSkillDestinationRequest(null);
    }
  };

  const closeSharedSkillDestination = () => {
    if (sharedSkillDestinationBusyId()) return;
    setSharedSkillDestinationRequest(null);
  };

  const openCreateWorkerFromSharedSkillDestination = () => {
    const request = sharedSkillDestinationRequest();
    if (!request) return;
    options.setError(null);
    setSharedBundleCreateWorkerRequest({
      request: request.request,
      bundle: request.bundle,
      defaultPreset: "minimal",
    });
    options.workspaceStore.setCreateWorkspaceOpen(true);
  };

  return {
    queueSharedBundleDeepLink,
    queueSharedBundleInvite,
    openDebugSharedBundleLink,
    openCloudTemplate,
    startWorkspaceFromCloudTemplate,
    sharedBundleImportChoice,
    sharedBundleImportCopy,
    sharedBundleWorkerOptions,
    sharedBundleImportBusy,
    sharedBundleImportError,
    closeSharedBundleImportChoice,
    openSharedBundleCreateWorkerFlow,
    importSharedBundleIntoExistingWorkspace,
    sharedTemplateStartRequest,
    sharedTemplateStartItems,
    sharedTemplateStartBusy,
    closeTemplateStart,
    startWorkspaceFromTemplate,
    createWorkspaceDefaultPreset,
    sharedBundleCreateWorkerRequest,
    clearSharedBundleCreateWorkerRequest,
    confirmCreateWorkspaceImport,
    confirmCreateSandboxImport,
    sharedSkillDestinationRequest,
    sharedSkillDestinationBusyId,
    sharedSkillDestinationWorkspaces,
    closeSharedSkillDestination,
    importSharedSkillIntoWorkspace,
    openCreateWorkerFromSharedSkillDestination,
    sharedSkillSuccessToast,
    clearSharedSkillSuccessToast,
  };
}
