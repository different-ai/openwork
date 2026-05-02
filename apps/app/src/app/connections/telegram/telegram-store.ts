import { createStore } from "solid-js/store";
import {
  fetchTelegramIdentities,
  upsertTelegramIdentity,
  deleteTelegramIdentity,
  type TelegramIdentity,
} from "./telegram-api";

export type ConnectorStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "error"
  | "disabled";

interface TelegramState {
  status: ConnectorStatus;
  identity: TelegramIdentity | null;
  errorMessage: string | null;
}

const [state, setState] = createStore<TelegramState>({
  status: "idle",
  identity: null,
  errorMessage: null,
});

export { state as telegramState };

let pollTimer: ReturnType<typeof setInterval> | null = null;

function startPolling(workspacePath: string) {
  if (pollTimer) return;
  pollTimer = setInterval(() => refreshStatus(workspacePath), 5000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

export async function refreshStatus(workspacePath: string) {
  const ids = await fetchTelegramIdentities(workspacePath);
  if (!ids.length) {
    setState({ status: "idle", identity: null, errorMessage: null });
    stopPolling();
    return;
  }
  const id = ids[0];
  setState({
    status: id.status === "connected" ? "connected" : "error",
    identity: id,
    errorMessage: id.errorMessage ?? null,
  });
}

export async function connectTelegram(botToken: string, workspacePath: string) {
  setState({ status: "connecting", errorMessage: null });
  const result = await upsertTelegramIdentity(botToken, workspacePath);
  if (!result.ok) {
    setState({ status: "error", errorMessage: result.error ?? "Failed to connect" });
    return;
  }
  setState({ status: "connected", identity: result.identity ?? null });
  startPolling(workspacePath);
}

export async function disconnectTelegram(workspacePath: string) {
  const id = state.identity?.id;
  stopPolling();
  setState({ status: "disabled", identity: null, errorMessage: null });
  if (id) await deleteTelegramIdentity(id);
  setState({ status: "idle" });
}

export async function initTelegramStore(workspacePath: string) {
  await refreshStatus(workspacePath);
  if (state.status === "connected") startPolling(workspacePath);
}
