import type { DesktopCommandName, DesktopCommandArgs, DesktopCommandResult } from "@openwork/types/desktop-ipc";
import type { OpenworkContextSnapshot } from "@openwork/types/openwork-context";

/** Test-facing browser protocols. State is installed by the corresponding world before use. */
declare global {
  interface Window {
    __openworkControl: {
      listActions(): { id: string; disabled: boolean; args?: unknown; [key: string]: unknown }[];
      execute(action: string, args?: unknown): Promise<{ ok: boolean; error?: string; result?: unknown; value?: unknown }>;
      context(): OpenworkContextSnapshot;
      snapshot(): { route: string; narration: string };
      setEnabled(enabled: boolean): void;
      command(request: { id: string; args?: unknown; [key: string]: unknown }): Promise<unknown>;
    };
    __reauthOriginalOpen?: typeof window.open;
    __OPENWORK_ELECTRON__: {
      shell: { relaunch(): Promise<void> };
      browserLogins: {
        testWitnessUrl(): Promise<string>;
        writeTestStore(request: { path: string; cookies: unknown[] }): Promise<unknown>;
        signedInSites(): Promise<unknown>;
        state(): Promise<unknown>;
        pause(): Promise<unknown>;
      };
      invokeDesktop<C extends DesktopCommandName>(command: C, ...args: DesktopCommandArgs<C>): Promise<DesktopCommandResult<C>>;
      browser: {
        openUrl(url: string, provider?: string, options?: { sessionId?: string | null }): Promise<{ tab_id: string; target_id: string; [key: string]: unknown }>;
        createTab(url?: string, sessionId?: string | null): Promise<{ tabId: string }>;
        getState(): Promise<{ activeTabId: string | null; tabs: Array<{ id: string; url: string; ownerSessionId: string | null }>; [key: string]: unknown }>;
        setControlEnabled(enabled: boolean): Promise<boolean>;
        [key: string]: unknown;
      };
      updater: {
        getChannel(): Promise<{ channel: "stable" | "alpha"; currentVersion: string }>;
        setChannel(channel: "stable" | "alpha"): Promise<{ channel: "stable" | "alpha"; currentVersion: string }>;
      };
    };
    __openwork: {
      events(limit?: number): { at: number; name: string; data: unknown }[];
      slice(name: "composer"): {
        snapshotQuery: {
          status: "pending" | "error" | "success";
          fetchStatus: "fetching" | "paused" | "idle";
          isPaused: boolean;
          failureCount: number;
          errorName: string | null;
          errorMessage: string | null;
          dataSessionId: string | null;
          dataMessageCount: number | null;
          currentSnapshotId: string | null;
          intendedSessionId: string;
          opencodeBaseUrl: { origin: string | null; pathname: string | null };
          tokenPresent: boolean;
        };
      };
      slice(name: "route"): {
        selectedWorkspaceId: string | null;
        workspaces: { id: string; name?: string; displayName?: string; displayNameResolved?: string; loading?: boolean; error?: string | null }[];
        sessionsByWorkspaceId: Record<string, { id: string; title?: string }[]>;
      };
    };
    __openworkRecoveryControl: { snapshot(): Promise<unknown>; select(id: string): Promise<unknown> };
    __openworkApplyDesktopConfig(config: { allowAlphaUpdates?: boolean; brandAppName?: string; brandLogoUrl?: string }): void;
    __openworkSetDesktopConfigRefreshResult(config: { allowAlphaUpdates?: boolean; brandAppName?: string; brandLogoUrl?: string }): void;
    __openworkReadDesktopVersionMetadataEval(): { minAppVersion: string; latestAppVersion: string; publishedDesktopVersions: string[] };
    __openworkUpdaterEvalBridge: {
      getChannel(): Promise<{ channel: string; currentVersion: string }>;
      setChannel(channel: "stable" | "alpha"): Promise<{ channel: string; currentVersion: string }>;
      check(channel?: "stable" | "alpha"): Promise<unknown>;
      download(): Promise<unknown>;
      installAndRestart(): Promise<unknown>;
      onDownloadProgress(callback?: (progress: unknown) => void): () => void;
    };
    __backgroundUpdateWitness: { checks: number; downloads: number; installs: number; offset: number; finishDownload: (() => void) | null; intervalCheck: (() => void) | null };
    __openworkAlphaUpdateEligibilityEvalState: { checks: (string | undefined)[]; currentVersion: string; latestVersion: string };
    __openworkUpdaterEvalState: { checks: (string | undefined)[]; setChannels: string[]; stableStarted: boolean; finishStable: (() => void) | null };
    __issue3980NotificationProbe: { observer: MutationObserver; state: { rawSeen: boolean } };
    __libraryStability: { requests: string[]; denEvents: number; samples: { buttons: number; contentVisible: boolean }[]; sampler?: number };
    __libraryLifecycleReads: number;
    __librarySkillReads: number;
    __opencodeConfigReads: number;
    __newTaskRequests: string[];
    __newTaskOpenedAfterMs: number;
    __sessionSettingsRuntimeErrors: string[];
    __workspaceStormSettingsGate: { entered: boolean; released: boolean; firstCompleted: boolean; errors: string[]; release(): void };
    __modelSelectionProof: { changes: number; loops: number; unavailable: boolean };
    __clicks: number;
    __handoffProofEvents: string[];
    mockupExecuted: boolean;
    [key: `text-observation-${string}`]: { state: { samples: string[]; frames: number; expired: boolean; overflow: boolean }; stop(): void } | undefined;
    [key: `transcript-observer-${string}`]: { state: { frames: number; seen: boolean[]; violations: { index: number; count: number; atMs: number }[]; stopped: boolean }; stop(): void } | undefined;
  }
  interface HTMLElement {
    _valueTracker?: { setValue(value: string): void };
    [key: `__reactFiber$${string}`]: BrowserFiber | undefined;
  }
  interface BrowserFiber {
    elementType?: { name?: string };
    type?: { name?: string };
    return: BrowserFiber | null;
    memoizedState: BrowserHook | null;
  }
  interface BrowserHook {
    queue?: { dispatch(action: { type: string; key: string; value: unknown }): void };
    next: BrowserHook | null;
  }
  var __attachmentUploadingSeen: boolean;
}
