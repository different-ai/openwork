/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState } from "react";

import { isElectronRuntime } from "../../../../app/utils";

// Mirrors the OpenShellDoctorResult shape produced by
// apps/desktop/electron/openshell/doctor.mjs. JSDoc on the main-side
// can't flow into renderer TS, so we re-declare the contract here.
export type OpenShellComponentState = "ok" | "warn" | "missing" | "unknown";

export type OpenShellComponent = {
  id: string;
  label: string;
  state: OpenShellComponentState;
  version: string | null;
  detail: string | null;
  actionable?: string | null;
};

export type OpenShellDoctorStatus = "ready" | "degraded" | "missing" | "unsupported";

export type OpenShellDoctorResult = {
  status: OpenShellDoctorStatus;
  components: OpenShellComponent[];
  actionable: string[];
  fatal: string[];
};

export type OpenShellInstallProgress = {
  phase: string;
  status?: string;
  message?: string | null;
  percent?: number;
  error?: string | null;
};

export type OpenShellInstallStatus = {
  status: "idle" | "running" | "ready" | "reboot_required" | "cancelled" | "cancelling" | "failed";
  lastEvent?: OpenShellInstallProgress | null;
  state?: {
    completed: string[];
    rebootRequired: boolean;
    lastError: string | null;
    startedAt: number | null;
    updatedAt: number | null;
  };
};

export type OpenEralCredentialKey =
  | "databaseUrl"
  | "anthropicApiKey"
  | "stringcostApiKey";

export type OpenEralCredentialStatus = {
  databaseUrl: "set" | "unset";
  anthropicApiKey: "set" | "unset";
  stringcostApiKey: "set" | "unset";
  encryptionAvailable: boolean;
};

type ElectronBridge = NonNullable<Window["__OPENWORK_ELECTRON__"]>;

function getBridge(): ElectronBridge | null {
  if (typeof window === "undefined") return null;
  return window.__OPENWORK_ELECTRON__ ?? null;
}

async function invoke<T>(command: string, ...args: unknown[]): Promise<T> {
  const bridge = getBridge();
  if (!bridge?.invokeDesktop) {
    throw new Error("Electron desktop bridge is not available.");
  }
  return (await bridge.invokeDesktop(command, ...args)) as T;
}

const DOCTOR_POLL_INTERVAL_MS = 5_000;
const PROGRESS_LOG_MAX = 200;

export function useOpenShellState(options: { active: boolean } = { active: false }) {
  const { active } = options;
  const [doctor, setDoctor] = useState<OpenShellDoctorResult | null>(null);
  const [doctorLoading, setDoctorLoading] = useState(false);
  const [doctorError, setDoctorError] = useState<string | null>(null);
  const [installStatus, setInstallStatus] = useState<OpenShellInstallStatus | null>(null);
  const [progressLog, setProgressLog] = useState<OpenShellInstallProgress[]>([]);
  const [policies, setPolicies] = useState<string[]>([]);
  const [credentialStatus, setCredentialStatus] = useState<OpenEralCredentialStatus | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const refreshDoctor = useCallback(async () => {
    if (!isElectronRuntime()) return;
    setDoctorLoading(true);
    setDoctorError(null);
    try {
      const result = await invoke<OpenShellDoctorResult>("openshellDoctor");
      if (isMountedRef.current) setDoctor(result);
    } catch (err) {
      if (isMountedRef.current) {
        setDoctorError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (isMountedRef.current) setDoctorLoading(false);
    }
  }, []);

  const refreshInstallStatus = useCallback(async () => {
    if (!isElectronRuntime()) return;
    try {
      const status = await invoke<OpenShellInstallStatus>("openshellInstallStatus");
      if (isMountedRef.current) setInstallStatus(status);
    } catch (err) {
      // Stale state is fine; surface only if it happens during a user action.
      if (isMountedRef.current && actionBusy) {
        setActionError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [actionBusy]);

  const refreshPolicies = useCallback(async () => {
    if (!isElectronRuntime()) return;
    try {
      const list = await invoke<string[]>("openshellListPolicies");
      if (isMountedRef.current) setPolicies(Array.isArray(list) ? list : []);
    } catch {
      if (isMountedRef.current) setPolicies([]);
    }
  }, []);

  const refreshCredentialStatus = useCallback(async () => {
    if (!isElectronRuntime()) return;
    try {
      const status = await invoke<OpenEralCredentialStatus>("openeralCredentialStatus");
      if (isMountedRef.current) setCredentialStatus(status);
    } catch {
      // Quiet — surfaces only on explicit set/clear attempts.
    }
  }, []);

  // Subscribe to streaming install progress whenever the bridge exposes
  // the openshell namespace (post-Phase-5 builds). One subscription per
  // mount; unsubscribe on unmount.
  useEffect(() => {
    if (!isElectronRuntime()) return;
    const bridge = getBridge();
    const sub = bridge?.openshell?.onInstallProgress;
    if (!sub) return;
    const unsubscribe = sub((evt: OpenShellInstallProgress) => {
      if (!isMountedRef.current) return;
      setProgressLog((prev) => {
        const next = prev.concat(evt);
        return next.length > PROGRESS_LOG_MAX ? next.slice(-PROGRESS_LOG_MAX) : next;
      });
      // A "done" or "error" terminal event triggers a status refresh so
      // the snapshot is consistent with what was streamed.
      if (evt.phase === "done" || evt.phase === "error") {
        void refreshInstallStatus();
        void refreshDoctor();
      }
    });
    return () => unsubscribe();
  }, [refreshInstallStatus, refreshDoctor]);

  // Poll doctor + install status on a steady cadence while the user is
  // looking at the sandbox tab. Outside the tab we don't waste cycles.
  useEffect(() => {
    if (!active || !isElectronRuntime()) return;
    void refreshDoctor();
    void refreshInstallStatus();
    void refreshPolicies();
    void refreshCredentialStatus();
    const id = setInterval(() => {
      void refreshDoctor();
      void refreshInstallStatus();
    }, DOCTOR_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active, refreshDoctor, refreshInstallStatus, refreshPolicies, refreshCredentialStatus]);

  const startInstall = useCallback(async () => {
    setActionBusy(true);
    setActionError(null);
    setProgressLog([]);
    try {
      await invoke<OpenShellInstallStatus>("openshellInstallStart");
      await refreshInstallStatus();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  }, [refreshInstallStatus]);

  const cancelInstall = useCallback(async () => {
    setActionError(null);
    try {
      await invoke("openshellInstallCancel");
      await refreshInstallStatus();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, [refreshInstallStatus]);

  const restartGateway = useCallback(async () => {
    setActionBusy(true);
    setActionError(null);
    try {
      await invoke("openshellGatewayRestart");
      await refreshDoctor();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  }, [refreshDoctor]);

  const openPoliciesFolder = useCallback(async () => {
    setActionError(null);
    try {
      await invoke("openshellOpenPoliciesFolder");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const setCredential = useCallback(
    async (key: OpenEralCredentialKey, value: string) => {
      setActionBusy(true);
      setActionError(null);
      try {
        const status = await invoke<OpenEralCredentialStatus>("openeralSetCredential", {
          key,
          value,
        });
        if (isMountedRef.current) setCredentialStatus(status);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        setActionBusy(false);
      }
    },
    [],
  );

  const clearCredential = useCallback(
    async (key: OpenEralCredentialKey) => {
      setActionBusy(true);
      setActionError(null);
      try {
        const status = await invoke<OpenEralCredentialStatus>("openeralClearCredential", key);
        if (isMountedRef.current) setCredentialStatus(status);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setActionBusy(false);
      }
    },
    [],
  );

  const testDatabaseUrl = useCallback(async () => {
    setActionBusy(true);
    setActionError(null);
    try {
      const result = await invoke<{ status: string; probedReachable?: boolean }>(
        "openeralTestDatabase",
      );
      return result;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setActionBusy(false);
    }
  }, []);

  const resetDistro = useCallback(async () => {
    setActionBusy(true);
    setActionError(null);
    try {
      const result = await invoke<{ status: string }>("openshellResetDistro");
      if (result?.status === "reset") {
        // Force a fresh doctor + installer-state read so the UI snaps to
        // "Install OpenShell" instead of showing a green checklist for a
        // distro that no longer exists.
        await refreshDoctor();
        await refreshInstallStatus();
        setProgressLog([]);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  }, [refreshDoctor, refreshInstallStatus]);

  return {
    doctor,
    doctorLoading,
    doctorError,
    installStatus,
    progressLog,
    policies,
    actionBusy,
    actionError,
    credentialStatus,
    startInstall,
    cancelInstall,
    restartGateway,
    resetDistro,
    openPoliciesFolder,
    setCredential,
    clearCredential,
    testDatabaseUrl,
    refreshDoctor,
    refreshInstallStatus,
    refreshPolicies,
    refreshCredentialStatus,
  };
}
