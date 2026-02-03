import { createSignal } from "solid-js";

import type { UpdateHandle } from "../types";
import type { UpdateChannel, UpdaterEnvironment } from "../lib/tauri";

export type UpdateStatus =
  | { state: "idle"; lastCheckedAt: number | null }
  | { state: "checking"; startedAt: number }
  | { state: "available"; lastCheckedAt: number; version: string; date?: string; notes?: string }
  | {
      state: "downloading";
      lastCheckedAt: number;
      version: string;
      totalBytes: number | null;
      downloadedBytes: number;
      notes?: string;
    }
  | { state: "ready"; lastCheckedAt: number; version: string; notes?: string }
  | { state: "applying"; lastCheckedAt: number; version: string; notes?: string }
  | { state: "restart-required"; lastCheckedAt: number; version: string; notes?: string }
  | { state: "error"; lastCheckedAt: number | null; message: string };

export type PendingUpdate = { version: string; notes?: string; date?: string } | null;

export function createUpdaterState() {
  const [updateAutoCheck, setUpdateAutoCheck] = createSignal(true);
  const [updateStatus, setUpdateStatus] = createSignal<UpdateStatus>({ state: "idle", lastCheckedAt: null });
  const [pendingUpdate, setPendingUpdate] = createSignal<PendingUpdate>(null);
  const [updateEnv, setUpdateEnv] = createSignal<UpdaterEnvironment | null>(null);
  const [updateChannel, setUpdateChannel] = createSignal<UpdateChannel>("stable");

  return {
    updateAutoCheck,
    setUpdateAutoCheck,
    updateStatus,
    setUpdateStatus,
    pendingUpdate,
    setPendingUpdate,
    updateEnv,
    setUpdateEnv,
    updateChannel,
    setUpdateChannel,
  } as const;
}
