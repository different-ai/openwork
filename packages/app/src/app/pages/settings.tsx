import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import { formatBytes, formatRelativeTime, isTauriRuntime } from "../utils";

import Button from "../components/button";
import TextInput from "../components/text-input";
import SettingsKeybinds, { type KeybindSetting } from "../components/settings-keybinds";
import { ChevronDown, HardDrive, MessageCircle, RefreshCcw, Shield, Smartphone, X } from "lucide-solid";
import type { SettingsTab } from "../types";
import type { OpenworkAuditEntry, OpenworkServerCapabilities, OpenworkServerSettings, OpenworkServerStatus } from "../lib/openwork-server";
import type {
  EngineInfo,
  OpenworkServerInfo,
  OwpenbotInfo,
  OwpenbotStatus,
  OwpenbotPairingRequest,
} from "../lib/tauri";
import {
  getOwpenbotStatus,
  getOwpenbotQr,
  setOwpenbotDmPolicy,
  setOwpenbotAllowlist,
  setOwpenbotTelegramToken,
  getOwpenbotPairingRequests,
  approveOwpenbotPairing,
  denyOwpenbotPairing,
} from "../lib/tauri";

export type SettingsViewProps = {
  mode: "host" | "client" | null;
  baseUrl: string;
  headerStatus: string;
  busy: boolean;
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerUrl: string;
  openworkServerSettings: OpenworkServerSettings;
  openworkServerHostInfo: OpenworkServerInfo | null;
  openworkServerCapabilities: OpenworkServerCapabilities | null;
  openworkServerWorkspaceId: string | null;
  openworkAuditEntries: OpenworkAuditEntry[];
  openworkAuditStatus: "idle" | "loading" | "error";
  openworkAuditError: string | null;
  engineInfo: EngineInfo | null;
  owpenbotInfo: OwpenbotInfo | null;
  updateOpenworkServerSettings: (next: OpenworkServerSettings) => void;
  resetOpenworkServerSettings: () => void;
  testOpenworkServerConnection: (next: OpenworkServerSettings) => Promise<boolean>;
  developerMode: boolean;
  toggleDeveloperMode: () => void;
  stopHost: () => void;
  keybindItems: KeybindSetting[];
  onOverrideKeybind: (id: string, keybind: string | null) => void;
  onResetKeybind: (id: string) => void;
  onResetAllKeybinds: () => void;
  engineSource: "path" | "sidecar";
  setEngineSource: (value: "path" | "sidecar") => void;
  isWindows: boolean;
  defaultModelLabel: string;
  defaultModelRef: string;
  openDefaultModelPicker: () => void;
  showThinking: boolean;
  toggleShowThinking: () => void;
  modelVariantLabel: string;
  editModelVariant: () => void;
  themeMode: "light" | "dark" | "system";
  setThemeMode: (value: "light" | "dark" | "system") => void;
  updateAutoCheck: boolean;
  toggleUpdateAutoCheck: () => void;
  updateStatus: {
    state: string;
    lastCheckedAt?: number | null;
    version?: string;
    date?: string;
    notes?: string;
    totalBytes?: number | null;
    downloadedBytes?: number;
    message?: string;
  } | null;
  updateEnv: { supported?: boolean; reason?: string | null } | null;
  appVersion: string | null;
  checkForUpdates: () => void;
  downloadUpdate: () => void;
  installUpdateAndRestart: () => void;
  anyActiveRuns: boolean;
  onResetStartupPreference: () => void;
  openResetModal: (mode: "onboarding" | "all") => void;
  resetModalBusy: boolean;
  pendingPermissions: unknown;
  events: unknown;
  safeStringify: (value: unknown) => string;
  repairOpencodeCache: () => void;
  cacheRepairBusy: boolean;
  cacheRepairResult: string | null;
  notionStatus: "disconnected" | "connecting" | "connected" | "error";
  notionStatusDetail: string | null;
  notionError: string | null;
  notionBusy: boolean;
  connectNotion: () => void;
};

// Owpenbot Settings Component
function OwpenbotSettings(props: { busy: boolean }) {
  const [owpenbotStatus, setOwpenbotStatus] = createSignal<OwpenbotStatus | null>(null);
  const [qrCode, setQrCode] = createSignal<string | null>(null);
  const [qrLoading, setQrLoading] = createSignal(false);
  const [pairingRequests, setPairingRequests] = createSignal<OwpenbotPairingRequest[]>([]);
  const [telegramToken, setTelegramToken] = createSignal("");
  const [telegramTokenVisible, setTelegramTokenVisible] = createSignal(false);
  const [newAllowlistEntry, setNewAllowlistEntry] = createSignal("");
  const [savingPolicy, setSavingPolicy] = createSignal(false);
  const [savingAllowlist, setSavingAllowlist] = createSignal(false);
  const [savingTelegram, setSavingTelegram] = createSignal(false);

  // Load owpenbot status on mount
  onMount(async () => {
    await refreshStatus();
    await refreshPairingRequests();
  });

  const refreshStatus = async () => {
    const status = await getOwpenbotStatus();
    setOwpenbotStatus(status);
  };

  const refreshPairingRequests = async () => {
    const requests = await getOwpenbotPairingRequests();
    setPairingRequests(requests);
  };

  const showQrCode = async () => {
    setQrLoading(true);
    try {
      const qr = await getOwpenbotQr();
      if (qr) {
        setQrCode(qr.qr);
      }
    } finally {
      setQrLoading(false);
    }
  };

  const hideQrCode = () => {
    setQrCode(null);
  };

  const handleDmPolicyChange = async (policy: OwpenbotStatus["whatsapp"]["dmPolicy"]) => {
    setSavingPolicy(true);
    try {
      await setOwpenbotDmPolicy(policy);
      await refreshStatus();
    } finally {
      setSavingPolicy(false);
    }
  };

  const handleAddAllowlistEntry = async () => {
    const entry = newAllowlistEntry().trim();
    if (!entry) return;
    
    setSavingAllowlist(true);
    try {
      const current = owpenbotStatus()?.whatsapp.allowFrom || [];
      if (!current.includes(entry)) {
        await setOwpenbotAllowlist([...current, entry]);
        await refreshStatus();
      }
      setNewAllowlistEntry("");
    } finally {
      setSavingAllowlist(false);
    }
  };

  const handleRemoveAllowlistEntry = async (entry: string) => {
    setSavingAllowlist(true);
    try {
      const current = owpenbotStatus()?.whatsapp.allowFrom || [];
      await setOwpenbotAllowlist(current.filter((e) => e !== entry));
      await refreshStatus();
    } finally {
      setSavingAllowlist(false);
    }
  };

  const handleSaveTelegramToken = async () => {
    const token = telegramToken().trim();
    if (!token) return;
    
    setSavingTelegram(true);
    try {
      await setOwpenbotTelegramToken(token);
      await refreshStatus();
      setTelegramToken("");
    } finally {
      setSavingTelegram(false);
    }
  };

  const handleApprovePairing = async (code: string) => {
    await approveOwpenbotPairing(code);
    await refreshPairingRequests();
  };

  const handleDenyPairing = async (code: string) => {
    await denyOwpenbotPairing(code);
    await refreshPairingRequests();
  };

  const bridgeStatusStyle = createMemo(() => {
    if (owpenbotStatus()?.running) {
      return "bg-green-7/10 text-green-11 border-green-7/20";
    }
    return "bg-gray-4/60 text-gray-11 border-gray-7/50";
  });

  const whatsappStatusStyle = createMemo(() => {
    if (owpenbotStatus()?.whatsapp.linked) {
      return "text-green-11";
    }
    return "text-gray-9";
  });

  const telegramStatusStyle = createMemo(() => {
    if (owpenbotStatus()?.telegram.configured) {
      return "text-green-11";
    }
    return "text-gray-9";
  });

  const dmPolicyOptions: { value: OwpenbotStatus["whatsapp"]["dmPolicy"]; label: string; description: string }[] = [
    { value: "pairing", label: "Pairing", description: "Requires approval for new contacts" },
    { value: "allowlist", label: "Allowlist", description: "Only specific numbers can message" },
    { value: "open", label: "Open", description: "Anyone can message (public)" },
    { value: "disabled", label: "Disabled", description: "DMs are disabled" },
  ];

  return (
    <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
      <div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <div class="flex items-center gap-2">
            <MessageCircle size={16} class="text-gray-11" />
            <div class="text-sm font-medium text-gray-12">Messaging Bridge</div>
          </div>
          <div class="text-xs text-gray-10 mt-1">Connect Telegram and WhatsApp to chat with your AI.</div>
        </div>
        <div class={`text-xs px-2 py-1 rounded-full border ${bridgeStatusStyle()}`}>
          {owpenbotStatus()?.running ? "Running" : "Offline"}
        </div>
      </div>

      {/* Telegram Section */}
      <div class="bg-gray-1 rounded-xl border border-gray-6 p-4 space-y-4">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <div class="w-6 h-6 rounded-full bg-blue-7/20 flex items-center justify-center">
              <span class="text-xs">T</span>
            </div>
            <span class="text-sm font-medium text-gray-12">Telegram</span>
          </div>
          <span class={`text-xs ${telegramStatusStyle()}`}>
            {owpenbotStatus()?.telegram.configured ? "Configured" : "Not configured"}
          </span>
        </div>

        <div class="space-y-2">
          <div class="text-xs font-medium text-gray-11">Bot Token</div>
          <div class="flex gap-2">
            <div class="flex-1 flex items-center gap-2">
              <input
                type={telegramTokenVisible() ? "text" : "password"}
                value={telegramToken()}
                onInput={(e) => setTelegramToken(e.currentTarget.value)}
                placeholder="Paste token from @BotFather"
                class="flex-1 rounded-lg bg-gray-2/60 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-10 shadow-[0_0_0_1px_rgba(255,255,255,0.08)] focus:outline-none focus:ring-2 focus:ring-gray-6/20"
                disabled={props.busy || savingTelegram()}
              />
              <Button
                variant="outline"
                class="text-xs h-9 px-3 shrink-0"
                onClick={() => setTelegramTokenVisible((prev) => !prev)}
              >
                {telegramTokenVisible() ? "Hide" : "Show"}
              </Button>
            </div>
            <Button
              variant="secondary"
              class="text-xs h-9 px-3"
              onClick={handleSaveTelegramToken}
              disabled={props.busy || savingTelegram() || !telegramToken().trim()}
            >
              Save
            </Button>
          </div>
          <div class="text-[11px] text-gray-8">
            Create a bot with <span class="font-mono">@BotFather</span> on Telegram and paste the token here.
          </div>
        </div>

        <Show when={owpenbotStatus()?.telegram.configured}>
          <div class="flex items-center justify-between bg-gray-2/50 rounded-lg p-3">
            <div class="text-xs text-gray-11">
              Bot is {owpenbotStatus()?.telegram.enabled ? "enabled" : "disabled"}
            </div>
          </div>
        </Show>
      </div>

      {/* WhatsApp Section */}
      <div class="bg-gray-1 rounded-xl border border-gray-6 p-4 space-y-4">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <div class="w-6 h-6 rounded-full bg-green-7/20 flex items-center justify-center">
              <span class="text-xs">W</span>
            </div>
            <span class="text-sm font-medium text-gray-12">WhatsApp</span>
            <span class="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-7/10 text-amber-11 border border-amber-7/30">
              Alpha
            </span>
          </div>
          <span class={`text-xs ${whatsappStatusStyle()}`}>
            {owpenbotStatus()?.whatsapp.linked ? "Linked" : "Not linked"}
          </span>
        </div>

        <div class="text-[11px] text-amber-11">
          Help wanted: WhatsApp linking is unstable right now. Contributors welcome.
        </div>

        {/* QR Code Section */}
        <Show when={!owpenbotStatus()?.whatsapp.linked}>
          <div class="space-y-3">
            <Show
              when={qrCode()}
              fallback={
                <Button
                  variant="secondary"
                  class="w-full"
                  onClick={showQrCode}
                  disabled={props.busy || qrLoading()}
                >
                  {qrLoading() ? "Loading QR..." : "Show QR Code to Link"}
                </Button>
              }
            >
              <div class="relative">
                <div class="flex justify-center p-4 bg-white rounded-lg">
                  <img
                    src={`data:image/png;base64,${qrCode()}`}
                    alt="WhatsApp QR Code"
                    class="w-48 h-48"
                  />
                </div>
                <button
                  class="absolute top-2 right-2 p-1 rounded-full bg-gray-12/80 text-gray-1 hover:bg-gray-12"
                  onClick={hideQrCode}
                >
                  <X size={14} />
                </button>
                <div class="text-xs text-gray-10 text-center mt-2">
                  Scan with WhatsApp to link your account
                </div>
              </div>
            </Show>
          </div>
        </Show>

        {/* DM Policy */}
        <div class="space-y-2">
          <div class="text-xs font-medium text-gray-11">DM Policy</div>
          <div class="grid grid-cols-2 gap-2">
            <For each={dmPolicyOptions}>
              {(option) => (
                <button
                  class={`px-3 py-2 rounded-lg text-left transition-colors ${
                    owpenbotStatus()?.whatsapp.dmPolicy === option.value
                      ? "bg-gray-4 border border-gray-7"
                      : "bg-gray-2/60 border border-gray-6/50 hover:bg-gray-3"
                  }`}
                  onClick={() => handleDmPolicyChange(option.value)}
                  disabled={props.busy || savingPolicy()}
                >
                  <div class="text-xs font-medium text-gray-12">{option.label}</div>
                  <div class="text-[11px] text-gray-10">{option.description}</div>
                </button>
              )}
            </For>
          </div>
        </div>

        {/* Allowlist Editor */}
        <Show when={owpenbotStatus()?.whatsapp.dmPolicy === "allowlist"}>
          <div class="space-y-2">
            <div class="text-xs font-medium text-gray-11">Allowed Numbers</div>
            <div class="flex gap-2">
              <input
                type="text"
                value={newAllowlistEntry()}
                onInput={(e) => setNewAllowlistEntry(e.currentTarget.value)}
                placeholder="+1234567890"
                class="flex-1 rounded-lg bg-gray-2/60 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-10 shadow-[0_0_0_1px_rgba(255,255,255,0.08)] focus:outline-none focus:ring-2 focus:ring-gray-6/20"
                disabled={props.busy || savingAllowlist()}
              />
              <Button
                variant="secondary"
                class="text-xs h-9 px-3"
                onClick={handleAddAllowlistEntry}
                disabled={props.busy || savingAllowlist() || !newAllowlistEntry().trim()}
              >
                Add
              </Button>
            </div>
            <Show when={(owpenbotStatus()?.whatsapp.allowFrom || []).length > 0}>
              <div class="flex flex-wrap gap-2 mt-2">
                <For each={owpenbotStatus()?.whatsapp.allowFrom || []}>
                  {(entry) => (
                    <span class="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-gray-3 border border-gray-6 text-xs text-gray-12">
                      {entry}
                      <button
                        class="p-0.5 rounded hover:bg-gray-4"
                        onClick={() => handleRemoveAllowlistEntry(entry)}
                        disabled={props.busy || savingAllowlist()}
                      >
                        <X size={12} class="text-gray-10" />
                      </button>
                    </span>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </div>

      {/* Pairing Requests */}
      <Show when={pairingRequests().length > 0}>
        <div class="bg-gray-1 rounded-xl border border-amber-7/30 p-4 space-y-3">
          <div class="flex items-center gap-2">
            <div class="w-2 h-2 rounded-full bg-amber-9 animate-pulse" />
            <span class="text-sm font-medium text-gray-12">Pending Pairing Requests</span>
          </div>
          <div class="divide-y divide-gray-6/50">
            <For each={pairingRequests()}>
              {(request) => (
                <div class="flex items-center justify-between py-3 first:pt-0 last:pb-0">
                  <div class="min-w-0">
                    <div class="text-sm text-gray-12 truncate">{request.peerId}</div>
                    <div class="text-[11px] text-gray-9">
                      {request.platform === "whatsapp" ? "WhatsApp" : "Telegram"} · {formatRelativeTime(request.timestamp)}
                    </div>
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    <Button
                      variant="secondary"
                      class="text-xs h-8 py-0 px-3"
                      onClick={() => handleApprovePairing(request.code)}
                      disabled={props.busy}
                    >
                      Approve
                    </Button>
                    <Button
                      variant="ghost"
                      class="text-xs h-8 py-0 px-3"
                      onClick={() => handleDenyPairing(request.code)}
                      disabled={props.busy}
                    >
                      Deny
                    </Button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* Info Note */}
      <div class="text-[11px] text-gray-8">
        Messaging bridge connects your WhatsApp and Telegram to OpenCode. Messages are processed locally.
      </div>
    </div>
  );
}

export default function SettingsView(props: SettingsViewProps) {
  const updateState = () => props.updateStatus?.state ?? "idle";
  const updateNotes = () => props.updateStatus?.notes ?? null;
  const updateVersion = () => props.updateStatus?.version ?? null;
  const updateDate = () => props.updateStatus?.date ?? null;
  const updateLastCheckedAt = () => props.updateStatus?.lastCheckedAt ?? null;
  const updateDownloadedBytes = () => props.updateStatus?.downloadedBytes ?? null;
  const updateTotalBytes = () => props.updateStatus?.totalBytes ?? null;
  const updateErrorMessage = () => props.updateStatus?.message ?? null;

  const notionStatusLabel = () => {
    switch (props.notionStatus) {
      case "connected":
        return "Connected";
      case "connecting":
        return "Reload required";
      case "error":
        return "Connection failed";
      default:
        return "Not connected";
    }
  };

  const notionStatusStyle = () => {
    if (props.notionStatus === "connected") {
      return "bg-green-7/10 text-green-11 border-green-7/20";
    }
    if (props.notionStatus === "error") {
      return "bg-red-7/10 text-red-11 border-red-7/20";
    }
    if (props.notionStatus === "connecting") {
      return "bg-amber-7/10 text-amber-11 border-amber-7/20";
    }
    return "bg-gray-4/60 text-gray-11 border-gray-7/50";
  };

  const [openworkUrl, setOpenworkUrl] = createSignal("");
  const [openworkToken, setOpenworkToken] = createSignal("");
  const [openworkTokenVisible, setOpenworkTokenVisible] = createSignal(false);
  const [clientTokenVisible, setClientTokenVisible] = createSignal(false);
  const [hostTokenVisible, setHostTokenVisible] = createSignal(false);
  const [copyingField, setCopyingField] = createSignal<string | null>(null);
  let copyTimeout: number | undefined;

  createEffect(() => {
    setOpenworkUrl(props.openworkServerSettings.urlOverride ?? "");
    setOpenworkToken(props.openworkServerSettings.token ?? "");
  });

  const openworkStatusLabel = createMemo(() => {
    switch (props.openworkServerStatus) {
      case "connected":
        return "Connected";
      case "limited":
        return "Limited";
      default:
        return "Not connected";
    }
  });

  const openworkStatusStyle = createMemo(() => {
    switch (props.openworkServerStatus) {
      case "connected":
        return "bg-green-7/10 text-green-11 border-green-7/20";
      case "limited":
        return "bg-amber-7/10 text-amber-11 border-amber-7/20";
      default:
        return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    }
  });

  const engineStatusLabel = createMemo(() => {
    if (!isTauriRuntime()) return "Unavailable";
    return props.engineInfo?.running ? "Running" : "Offline";
  });

  const engineStatusStyle = createMemo(() => {
    if (!isTauriRuntime()) return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    return props.engineInfo?.running
      ? "bg-green-7/10 text-green-11 border-green-7/20"
      : "bg-gray-4/60 text-gray-11 border-gray-7/50";
  });

  const owpenbotStatusLabel = createMemo(() => {
    if (!isTauriRuntime()) return "Unavailable";
    return props.owpenbotInfo?.running ? "Running" : "Offline";
  });

  const owpenbotStatusStyle = createMemo(() => {
    if (!isTauriRuntime()) return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    return props.owpenbotInfo?.running
      ? "bg-green-7/10 text-green-11 border-green-7/20"
      : "bg-gray-4/60 text-gray-11 border-gray-7/50";
  });

  const openworkAuditStatusLabel = createMemo(() => {
    if (!props.openworkServerWorkspaceId) return "Unavailable";
    if (props.openworkAuditStatus === "loading") return "Loading";
    if (props.openworkAuditStatus === "error") return "Error";
    return "Ready";
  });

  const openworkAuditStatusStyle = createMemo(() => {
    if (!props.openworkServerWorkspaceId) return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    if (props.openworkAuditStatus === "loading") return "bg-amber-7/10 text-amber-11 border-amber-7/20";
    if (props.openworkAuditStatus === "error") return "bg-red-7/10 text-red-11 border-red-7/20";
    return "bg-green-7/10 text-green-11 border-green-7/20";
  });

  const tabLabel = (tab: SettingsTab) => {
    switch (tab) {
      case "model":
        return "Model";
      case "keybinds":
        return "Keybinds";
      case "advanced":
        return "Advanced";
      case "remote":
        return "Remote";
      case "messaging":
        return "Messaging Bridge";
      case "debug":
        return "Debug";
      default:
        return "General";
    }
  };

  const availableTabs = createMemo<SettingsTab[]>(() => {
    const tabs: SettingsTab[] = ["general", "model", "keybinds", "advanced", "remote", "messaging"];
    if (props.developerMode) tabs.push("debug");
    return tabs;
  });

  const activeTab = createMemo<SettingsTab>(() => {
    const tabs = availableTabs();
    return tabs.includes(props.settingsTab) ? props.settingsTab : "general";
  });

  createEffect(() => {
    if (props.settingsTab !== activeTab()) {
      props.setSettingsTab(activeTab());
    }
  });

  const formatActor = (entry: OpenworkAuditEntry) => {
    const actor = entry.actor;
    if (!actor) return "unknown";
    if (actor.type === "host") return "host";
    if (actor.type === "remote") {
      return actor.clientId ? `remote:${actor.clientId}` : "remote";
    }
    return "unknown";
  };

  const formatCapability = (cap?: { read?: boolean; write?: boolean; source?: string }) => {
    if (!cap) return "Unavailable";
    const parts = [cap.read ? "read" : null, cap.write ? "write" : null].filter(Boolean).join(" / ");
    const label = parts || "no access";
    return cap.source ? `${label} · ${cap.source}` : label;
  };

  const engineStdout = () => {
    if (!isTauriRuntime()) return "Available in the desktop app.";
    return props.engineInfo?.lastStdout?.trim() || "No stdout captured yet.";
  };

  const engineStderr = () => {
    if (!isTauriRuntime()) return "Available in the desktop app.";
    return props.engineInfo?.lastStderr?.trim() || "No stderr captured yet.";
  };

  const openworkStdout = () => {
    if (!props.openworkServerHostInfo) return "Logs are available on the host.";
    return props.openworkServerHostInfo.lastStdout?.trim() || "No stdout captured yet.";
  };

  const openworkStderr = () => {
    if (!props.openworkServerHostInfo) return "Logs are available on the host.";
    return props.openworkServerHostInfo.lastStderr?.trim() || "No stderr captured yet.";
  };

  const owpenbotStdout = () => {
    if (!isTauriRuntime()) return "Available in the desktop app.";
    return props.owpenbotInfo?.lastStdout?.trim() || "No stdout captured yet.";
  };

  const owpenbotStderr = () => {
    if (!isTauriRuntime()) return "Available in the desktop app.";
    return props.owpenbotInfo?.lastStderr?.trim() || "No stderr captured yet.";
  };

  const buildOpenworkSettings = () => ({
    ...props.openworkServerSettings,
    urlOverride: openworkUrl().trim() || undefined,
    token: openworkToken().trim() || undefined,
  });

  const hasOpenworkChanges = createMemo(() => {
    const currentUrl = props.openworkServerSettings.urlOverride ?? "";
    const currentToken = props.openworkServerSettings.token ?? "";
    return openworkUrl().trim() !== currentUrl || openworkToken().trim() !== currentToken;
  });

  const hostInfo = createMemo(() => props.openworkServerHostInfo);
  const hostStatusLabel = createMemo(() => {
    if (!hostInfo()?.running) return "Offline";
    return "Available";
  });
  const hostStatusStyle = createMemo(() => {
    if (!hostInfo()?.running) return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    return "bg-green-7/10 text-green-11 border-green-7/20";
  });
  const hostConnectUrl = createMemo(() => {
    const info = hostInfo();
    return info?.connectUrl ?? info?.mdnsUrl ?? info?.lanUrl ?? info?.baseUrl ?? "";
  });
  const hostConnectUrlUsesMdns = createMemo(() => hostConnectUrl().includes(".local"));

  const handleCopy = async (value: string, field: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopyingField(field);
      if (copyTimeout !== undefined) {
        window.clearTimeout(copyTimeout);
      }
      copyTimeout = window.setTimeout(() => {
        setCopyingField(null);
        copyTimeout = undefined;
      }, 2000);
    } catch {
      // ignore
    }
  };

  onCleanup(() => {
    if (copyTimeout !== undefined) {
      window.clearTimeout(copyTimeout);
    }
  });


  return (
    <section class="space-y-6">
      <div class="flex flex-wrap gap-2">
        <For each={availableTabs()}>
          {(tab) => (
            <button
              class={`px-3 py-2 rounded-xl text-xs font-medium border transition-colors ${
                activeTab() === tab
                  ? "bg-gray-12/10 text-gray-12 border-gray-6/30"
                  : "text-gray-10 border-gray-6/50 hover:text-gray-12 hover:bg-gray-2/40"
              }`}
              onClick={() => props.setSettingsTab(tab)}
            >
              {tabLabel(tab)}
            </button>
          )}
        </For>
      </div>

      <Switch>
        <Match when={activeTab() === "general"}>
          <div class="space-y-6">
            <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
              <div class="text-sm font-medium text-gray-12">Connection</div>
              <div class="text-xs text-gray-10">{props.headerStatus}</div>
              <div class="text-xs text-gray-7 font-mono">{props.baseUrl}</div>
              <div class="pt-2 flex flex-wrap gap-2">
                <Button variant="secondary" onClick={props.toggleDeveloperMode}>
                  <Shield size={16} />
                  {props.developerMode ? "Disable Developer Mode" : "Enable Developer Mode"}
                </Button>
                <Show when={props.mode === "host"}>
                  <Button variant="danger" onClick={props.stopHost} disabled={props.busy}>
                    Stop engine
                  </Button>
                </Show>
                <Show when={props.mode === "client"}>
                  <Button variant="outline" onClick={props.stopHost} disabled={props.busy}>
                    Disconnect
                  </Button>
                </Show>
              </div>
            </div>

            <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
              <div>
                <div class="text-sm font-medium text-gray-12">Appearance</div>
                <div class="text-xs text-gray-10">Match the system or force light/dark mode.</div>
              </div>

              <div class="flex flex-wrap gap-2">
                <Button
                  variant={props.themeMode === "system" ? "secondary" : "outline"}
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => props.setThemeMode("system")}
                  disabled={props.busy}
                >
                  System
                </Button>
                <Button
                  variant={props.themeMode === "light" ? "secondary" : "outline"}
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => props.setThemeMode("light")}
                  disabled={props.busy}
                >
                  Light
                </Button>
                <Button
                  variant={props.themeMode === "dark" ? "secondary" : "outline"}
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => props.setThemeMode("dark")}
                  disabled={props.busy}
                >
                  Dark
                </Button>
              </div>

              <div class="text-xs text-gray-7">
                System mode follows your OS preference automatically.
              </div>
            </div>
          </div>
        </Match>

        <Match when={activeTab() === "model"}>
          <div class="space-y-6">
            <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
              <div>
                <div class="text-sm font-medium text-gray-12">Model</div>
                <div class="text-xs text-gray-10">Defaults + thinking controls for runs.</div>
              </div>

              <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                <div class="min-w-0">
                  <div class="text-sm text-gray-12 truncate">{props.defaultModelLabel}</div>
                  <div class="text-xs text-gray-7 font-mono truncate">{props.defaultModelRef}</div>
                </div>
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3 shrink-0"
                  onClick={props.openDefaultModelPicker}
                  disabled={props.busy}
                >
                  Change
                </Button>
              </div>

              <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                <div class="min-w-0">
                  <div class="text-sm text-gray-12">Thinking</div>
                  <div class="text-xs text-gray-7">Show thinking parts (Developer mode only).</div>
                </div>
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3 shrink-0"
                  onClick={props.toggleShowThinking}
                  disabled={props.busy}
                >
                  {props.showThinking ? "On" : "Off"}
                </Button>
              </div>

              <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                <div class="min-w-0">
                  <div class="text-sm text-gray-12">Model variant</div>
                  <div class="text-xs text-gray-7 font-mono truncate">{props.modelVariantLabel}</div>
                </div>
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3 shrink-0"
                  onClick={props.editModelVariant}
                  disabled={props.busy}
                >
                  Edit
                </Button>
              </div>
            </div>
          </div>
        </Match>

        <Match when={activeTab() === "keybinds"}>
          <div class="space-y-6">
            <SettingsKeybinds
              items={props.keybindItems}
              onOverride={props.onOverrideKeybind}
              onReset={props.onResetKeybind}
              onResetAll={props.onResetAllKeybinds}
            />
          </div>
        </Match>

        <Match when={activeTab() === "advanced"}>
          <div class="space-y-6">
            <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <div class="text-sm font-medium text-gray-12">Updates</div>
                  <div class="text-xs text-gray-10">Keep OpenWork up to date.</div>
                </div>
                <div class="text-xs text-gray-7 font-mono">{props.appVersion ? `v${props.appVersion}` : ""}</div>
              </div>

              <Show
                when={!isTauriRuntime()}
                fallback={
                  <Show
                    when={props.updateEnv && props.updateEnv.supported === false}
                    fallback={
                      <>
                        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6">
                          <div class="space-y-0.5">
                            <div class="text-sm text-gray-12">Automatic checks</div>
                            <div class="text-xs text-gray-7">Once per day (quiet)</div>
                          </div>
                          <button
                            class={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                              props.updateAutoCheck
                                ? "bg-gray-12/10 text-gray-12 border-gray-6/20"
                                : "text-gray-10 border-gray-6 hover:text-gray-12"
                            }`}
                            onClick={props.toggleUpdateAutoCheck}
                          >
                            {props.updateAutoCheck ? "On" : "Off"}
                          </button>
                        </div>

                        <div class="flex items-center justify-between gap-3 bg-gray-1 p-3 rounded-xl border border-gray-6">
                          <div class="space-y-0.5">
                            <div class="text-sm text-gray-12">
                              <Switch>
                                <Match when={updateState() === "checking"}>Checking...</Match>
                                <Match when={updateState() === "available"}>Update available: v{updateVersion()}</Match>
                                <Match when={updateState() === "downloading"}>Downloading...</Match>
                                <Match when={updateState() === "ready"}>Ready to install: v{updateVersion()}</Match>
                                <Match when={updateState() === "error"}>Update check failed</Match>
                                <Match when={true}>Up to date</Match>
                              </Switch>
                            </div>
                            <Show when={updateState() === "idle" && updateLastCheckedAt()}>
                              <div class="text-xs text-gray-7">
                                Last checked {formatRelativeTime(updateLastCheckedAt() as number)}
                              </div>
                            </Show>
                            <Show when={updateState() === "available" && updateDate()}>
                              <div class="text-xs text-gray-7">Published {updateDate()}</div>
                            </Show>
                            <Show when={updateState() === "downloading"}>
                              <div class="text-xs text-gray-7">
                                {formatBytes((updateDownloadedBytes() as number) ?? 0)}
                                <Show when={updateTotalBytes() != null}>
                                  {` / ${formatBytes(updateTotalBytes() as number)}`}
                                </Show>
                              </div>
                            </Show>
                            <Show when={updateState() === "error"}>
                              <div class="text-xs text-red-11">{updateErrorMessage()}</div>
                            </Show>
                          </div>

                          <div class="flex items-center gap-2">
                            <Button
                              variant="outline"
                              class="text-xs h-8 py-0 px-3"
                              onClick={props.checkForUpdates}
                              disabled={props.busy || updateState() === "checking" || updateState() === "downloading"}
                            >
                              Check
                            </Button>

                            <Show when={updateState() === "available"}>
                              <Button
                                variant="secondary"
                                class="text-xs h-8 py-0 px-3"
                                onClick={props.downloadUpdate}
                                disabled={props.busy || updateState() === "downloading"}
                              >
                                Download
                              </Button>
                            </Show>

                            <Show when={updateState() === "ready"}>
                              <Button
                                variant="secondary"
                                class="text-xs h-8 py-0 px-3"
                                onClick={props.installUpdateAndRestart}
                                disabled={props.busy || props.anyActiveRuns}
                                title={props.anyActiveRuns ? "Stop active runs to update" : ""}
                              >
                                Install & Restart
                              </Button>
                            </Show>
                          </div>
                        </div>

                        <Show when={updateState() === "available" && updateNotes()}>
                          <div class="rounded-xl bg-gray-1/20 border border-gray-6 p-3 text-xs text-gray-11 whitespace-pre-wrap max-h-40 overflow-auto">
                            {updateNotes()}
                          </div>
                        </Show>
                      </>
                    }
                  >
                    <div class="rounded-xl bg-gray-1/20 border border-gray-6 p-3 text-sm text-gray-11">
                      {props.updateEnv?.reason ?? "Updates are not supported in this environment."}
                    </div>
                  </Show>
                }
              >
                <div class="rounded-xl bg-gray-1/20 border border-gray-6 p-3 text-sm text-gray-11">
                  Updates are only available in the desktop app.
                </div>
              </Show>
            </div>

            <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
              <div class="text-sm font-medium text-gray-12">Startup</div>

              <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6">
                <div class="flex items-center gap-3">
                  <div
                    class={`p-2 rounded-lg ${
                      props.mode === "host" ? "bg-indigo-7/10 text-indigo-11" : "bg-green-7/10 text-green-11"
                    }`}
                  >
                    <Show when={props.mode === "host"} fallback={<Smartphone size={18} />}>
                      <HardDrive size={18} />
                    </Show>
                  </div>
                  <span class="capitalize text-sm font-medium text-gray-12">{props.mode} mode</span>
                </div>
                <Button variant="outline" class="text-xs h-8 py-0 px-3" onClick={props.stopHost} disabled={props.busy}>
                  Switch
                </Button>
              </div>

              <Button variant="secondary" class="w-full justify-between group" onClick={props.onResetStartupPreference}>
                <span class="text-gray-11">Reset default startup mode</span>
                <RefreshCcw size={14} class="text-gray-10 group-hover:rotate-180 transition-transform" />
              </Button>

              <p class="text-xs text-gray-7">
                This clears your saved preference and shows mode selection on next launch.
              </p>
            </div>

            <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
              <div>
                <div class="text-sm font-medium text-gray-12">Advanced</div>
                <div class="text-xs text-gray-10">Power options for the engine and reset actions.</div>
              </div>

              <Show when={isTauriRuntime() && props.mode === "host"}>
                <div class="space-y-3">
                  <div class="text-xs text-gray-10">Engine source</div>
                  <div class="grid grid-cols-2 gap-2">
                    <Button
                      variant={props.engineSource === "sidecar" ? "secondary" : "outline"}
                      onClick={() => props.setEngineSource("sidecar")}
                      disabled={props.busy}
                    >
                      Bundled (recommended)
                    </Button>
                    <Button
                      variant={props.engineSource === "path" ? "secondary" : "outline"}
                      onClick={() => props.setEngineSource("path")}
                      disabled={props.busy}
                    >
                      System install (PATH)
                    </Button>
                  </div>
                  <div class="text-[11px] text-gray-7">
                    Bundled engine is the most reliable option. Use System install only if you manage OpenCode yourself.
                  </div>
                </div>
              </Show>

              <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                <div class="min-w-0">
                  <div class="text-sm text-gray-12">Reset onboarding</div>
                  <div class="text-xs text-gray-7">Clears OpenWork preferences and restarts the app.</div>
                </div>
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3 shrink-0"
                  onClick={() => props.openResetModal("onboarding")}
                  disabled={props.busy || props.resetModalBusy || props.anyActiveRuns}
                  title={props.anyActiveRuns ? "Stop active runs to reset" : ""}
                >
                  Reset
                </Button>
              </div>

              <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                <div class="min-w-0">
                  <div class="text-sm text-gray-12">Reset app data</div>
                  <div class="text-xs text-gray-7">More aggressive. Clears OpenWork cache + app data.</div>
                </div>
                <Button
                  variant="danger"
                  class="text-xs h-8 py-0 px-3 shrink-0"
                  onClick={() => props.openResetModal("all")}
                  disabled={props.busy || props.resetModalBusy || props.anyActiveRuns}
                  title={props.anyActiveRuns ? "Stop active runs to reset" : ""}
                >
                  Reset
                </Button>
              </div>

              <div class="text-xs text-gray-7">
                Requires typing <span class="font-mono text-gray-11">RESET</span> and will restart the app.
              </div>
            </div>
          </div>
        </Match>

        <Match when={activeTab() === "remote"}>
          <div class="space-y-6">
            <Show when={props.mode === "host"}>
              <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
                <div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div class="text-sm font-medium text-gray-12">Host pairing</div>
                    <div class="text-xs text-gray-10">Share these details with a trusted device.</div>
                  </div>
                  <div class={`text-xs px-2 py-1 rounded-full border ${hostStatusStyle()}`}>
                    {hostStatusLabel()}
                  </div>
                </div>

                <div class="grid gap-3">
                  <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                    <div class="min-w-0">
                      <div class="text-xs font-medium text-gray-11">OpenWork Server URL</div>
                      <div class="text-xs text-gray-7 font-mono truncate">
                        {hostConnectUrl() || "Starting server…"}
                      </div>
                      <Show when={hostConnectUrl()}>
                        <div class="text-[11px] text-gray-8 mt-1">
                          {hostConnectUrlUsesMdns()
                            ? ".local names are easier to remember but may not resolve on all networks."
                            : "Use your local IP on the same Wi-Fi for the fastest connection."}
                        </div>
                      </Show>
                    </div>
                    <Button
                      variant="outline"
                      class="text-xs h-8 py-0 px-3 shrink-0"
                      onClick={() => handleCopy(hostConnectUrl(), "host-url")}
                      disabled={!hostConnectUrl()}
                    >
                      {copyingField() === "host-url" ? "Copied" : "Copy"}
                    </Button>
                  </div>

                  <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                    <div class="min-w-0">
                      <div class="text-xs font-medium text-gray-11">Client token</div>
                      <div class="text-xs text-gray-7 font-mono truncate">
                        {clientTokenVisible()
                          ? hostInfo()?.clientToken || "—"
                          : hostInfo()?.clientToken
                            ? "••••••••••••"
                            : "—"}
                      </div>
                      <div class="text-[11px] text-gray-8 mt-1">Use on phones or laptops connecting to this host.</div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      <Button
                        variant="outline"
                        class="text-xs h-8 py-0 px-3"
                        onClick={() => setClientTokenVisible((prev) => !prev)}
                        disabled={!hostInfo()?.clientToken}
                      >
                        {clientTokenVisible() ? "Hide" : "Show"}
                      </Button>
                      <Button
                        variant="outline"
                        class="text-xs h-8 py-0 px-3"
                        onClick={() => handleCopy(hostInfo()?.clientToken ?? "", "client-token")}
                        disabled={!hostInfo()?.clientToken}
                      >
                        {copyingField() === "client-token" ? "Copied" : "Copy"}
                      </Button>
                    </div>
                  </div>

                  <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                    <div class="min-w-0">
                      <div class="text-xs font-medium text-gray-11">Host token</div>
                      <div class="text-xs text-gray-7 font-mono truncate">
                        {hostTokenVisible()
                          ? hostInfo()?.hostToken || "—"
                          : hostInfo()?.hostToken
                            ? "••••••••••••"
                            : "—"}
                      </div>
                      <div class="text-[11px] text-gray-8 mt-1">Keep private. Required for host approvals.</div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      <Button
                        variant="outline"
                        class="text-xs h-8 py-0 px-3"
                        onClick={() => setHostTokenVisible((prev) => !prev)}
                        disabled={!hostInfo()?.hostToken}
                      >
                        {hostTokenVisible() ? "Hide" : "Show"}
                      </Button>
                      <Button
                        variant="outline"
                        class="text-xs h-8 py-0 px-3"
                        onClick={() => handleCopy(hostInfo()?.hostToken ?? "", "host-token")}
                        disabled={!hostInfo()?.hostToken}
                      >
                        {copyingField() === "host-token" ? "Copied" : "Copy"}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </Show>

            <Show when={props.mode === "client"}>
              <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
                <div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div class="flex items-center gap-2">
                      <div class="text-sm font-medium text-gray-12">OpenWork host</div>
                      <span class="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-7/10 text-amber-11 border border-amber-7/30">
                        Alpha
                      </span>
                    </div>
                    <div class="text-xs text-gray-10">
                      OpenWork discovers your OpenCode address and port from the host. Use a host URL to connect across devices.
                    </div>
                  </div>
                  <div class={`text-xs px-2 py-1 rounded-full border ${openworkStatusStyle()}`}>
                    {openworkStatusLabel()}
                  </div>
                </div>

                <div class="grid gap-3">
                  <TextInput
                    label="OpenWork host URL"
                    value={openworkUrl()}
                    onInput={(event) => setOpenworkUrl(event.currentTarget.value)}
                    placeholder="http://127.0.0.1:8787"
                    hint="Use the host URL shared during pairing."
                    disabled={props.busy}
                  />

                  <label class="block">
                    <div class="mb-1 text-xs font-medium text-gray-11">Client token</div>
                    <div class="flex items-center gap-2">
                      <input
                        type={openworkTokenVisible() ? "text" : "password"}
                        value={openworkToken()}
                        onInput={(event) => setOpenworkToken(event.currentTarget.value)}
                        placeholder="Paste your token"
                        disabled={props.busy}
                        class="w-full rounded-xl bg-gray-2/60 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-10 shadow-[0_0_0_1px_rgba(255,255,255,0.08)] focus:outline-none focus:ring-2 focus:ring-gray-6/20"
                      />
                      <Button
                        variant="outline"
                        class="text-xs h-9 px-3 shrink-0"
                        onClick={() => setOpenworkTokenVisible((prev) => !prev)}
                        disabled={props.busy}
                      >
                        {openworkTokenVisible() ? "Hide" : "Show"}
                      </Button>
                    </div>
                    <div class="mt-1 text-xs text-gray-10">Optional. Paste the client token from the host to pair.</div>
                  </label>
                </div>

                <div class="text-[11px] text-gray-7 font-mono truncate">
                  Resolved host: {props.openworkServerUrl || "Not set"}
                </div>

                <div class="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      const next = buildOpenworkSettings();
                      props.updateOpenworkServerSettings(next);
                      await props.testOpenworkServerConnection(next);
                    }}
                    disabled={props.busy}
                  >
                    Test connection
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => props.updateOpenworkServerSettings(buildOpenworkSettings())}
                    disabled={props.busy || !hasOpenworkChanges()}
                  >
                    Save
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={props.resetOpenworkServerSettings}
                    disabled={props.busy}
                  >
                    Clear
                  </Button>
                </div>

                <details class="rounded-2xl border border-gray-6 bg-gray-1/40 px-4 py-3">
                  <summary class="flex items-center justify-between cursor-pointer text-xs text-gray-10">
                    Advanced: OpenCode direct
                    <ChevronDown size={14} class="text-gray-7" />
                  </summary>
                  <div class="pt-3 space-y-3">
                    <div class="text-xs text-gray-10">Connect straight to an OpenCode engine when no host is available.</div>
                    <div class="text-[11px] text-gray-7 font-mono truncate">
                      Current engine: {props.baseUrl || "Not connected"}
                    </div>
                    <div class="text-xs text-gray-8">Manage direct connections from the workspace picker.</div>
                  </div>
                </details>
              </div>
            </Show>
          </div>
        </Match>

        <Match when={activeTab() === "messaging"}>
          <div class="space-y-6">
            <OwpenbotSettings busy={props.busy} />
          </div>
        </Match>

        <Match when={activeTab() === "debug"}>
          <Show when={props.developerMode}>
            <section>
              <h3 class="text-sm font-medium text-gray-11 uppercase tracking-wider mb-4">Developer</h3>

              <div class="space-y-4">
                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                  <div class="min-w-0">
                    <div class="text-sm text-gray-12">OpenCode cache</div>
                    <div class="text-xs text-gray-7">
                      Repairs cached data used to start the engine. Safe to run.
                    </div>
                    <Show when={props.cacheRepairResult}>
                      <div class="text-xs text-gray-11 mt-2">{props.cacheRepairResult}</div>
                    </Show>
                  </div>
                  <Button
                    variant="secondary"
                    class="text-xs h-8 py-0 px-3 shrink-0"
                    onClick={props.repairOpencodeCache}
                    disabled={props.cacheRepairBusy || !isTauriRuntime()}
                    title={isTauriRuntime() ? "" : "Cache repair requires the desktop app"}
                  >
                    {props.cacheRepairBusy ? "Repairing cache" : "Repair cache"}
                  </Button>
                </div>

                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
                  <div>
                    <div class="text-sm font-medium text-gray-12">Devtools</div>
                    <div class="text-xs text-gray-10">Sidecar health, capabilities, and audit trail.</div>
                  </div>

                  <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <div class="text-sm font-medium text-gray-12">OpenCode engine</div>
                          <div class="text-xs text-gray-10">Local execution sidecar.</div>
                        </div>
                        <div class={`text-xs px-2 py-1 rounded-full border ${engineStatusStyle()}`}>
                          {engineStatusLabel()}
                        </div>
                      </div>
                      <div class="space-y-1">
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {props.engineInfo?.baseUrl ?? "Base URL unavailable"}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {props.engineInfo?.projectDir ?? "No project directory"}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">PID: {props.engineInfo?.pid ?? "—"}</div>
                      </div>
                      <div class="grid gap-2">
                        <div>
                          <div class="text-[11px] text-gray-9 mb-1">Last stdout</div>
                          <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {engineStdout()}
                          </pre>
                        </div>
                        <div>
                          <div class="text-[11px] text-gray-9 mb-1">Last stderr</div>
                          <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {engineStderr()}
                          </pre>
                        </div>
                      </div>
                    </div>

                    <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <div class="text-sm font-medium text-gray-12">OpenWork server</div>
                          <div class="text-xs text-gray-10">Config and approvals sidecar.</div>
                        </div>
                        <div class={`text-xs px-2 py-1 rounded-full border ${openworkStatusStyle()}`}>
                          {openworkStatusLabel()}
                        </div>
                      </div>
                      <div class="space-y-1">
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {(props.openworkServerHostInfo?.baseUrl ?? props.openworkServerUrl) || "Base URL unavailable"}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">PID: {props.openworkServerHostInfo?.pid ?? "—"}</div>
                      </div>
                      <div class="grid gap-2">
                        <div>
                          <div class="text-[11px] text-gray-9 mb-1">Last stdout</div>
                          <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {openworkStdout()}
                          </pre>
                        </div>
                        <div>
                          <div class="text-[11px] text-gray-9 mb-1">Last stderr</div>
                          <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {openworkStderr()}
                          </pre>
                        </div>
                      </div>
                    </div>

                    <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <div class="text-sm font-medium text-gray-12">Owpenbot sidecar</div>
                          <div class="text-xs text-gray-10">Messaging bridge service.</div>
                        </div>
                        <div class={`text-xs px-2 py-1 rounded-full border ${owpenbotStatusStyle()}`}>
                          {owpenbotStatusLabel()}
                        </div>
                      </div>
                      <div class="space-y-1">
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {props.owpenbotInfo?.opencodeUrl?.trim() || "OpenCode URL unavailable"}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {props.owpenbotInfo?.workspacePath?.trim() || "No workspace directory"}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">PID: {props.owpenbotInfo?.pid ?? "—"}</div>
                      </div>
                      <div class="grid gap-2">
                        <div>
                          <div class="text-[11px] text-gray-9 mb-1">Last stdout</div>
                          <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {owpenbotStdout()}
                          </pre>
                        </div>
                        <div>
                          <div class="text-[11px] text-gray-9 mb-1">Last stderr</div>
                          <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {owpenbotStderr()}
                          </pre>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                    <div class="flex items-center justify-between gap-3">
                      <div class="text-sm font-medium text-gray-12">OpenWork server capabilities</div>
                      <div class="text-[11px] text-gray-8 font-mono truncate">
                        {props.openworkServerWorkspaceId ? `Workspace ${props.openworkServerWorkspaceId}` : "Workspace unresolved"}
                      </div>
                    </div>
                    <Show
                      when={props.openworkServerCapabilities}
                      fallback={<div class="text-xs text-gray-9">Capabilities unavailable. Connect with a client token.</div>}
                    >
                      {(caps) => (
                        <div class="grid md:grid-cols-2 gap-2 text-xs text-gray-11">
                          <div>Skills: {formatCapability(caps().skills)}</div>
                          <div>Plugins: {formatCapability(caps().plugins)}</div>
                          <div>MCP: {formatCapability(caps().mcp)}</div>
                          <div>Commands: {formatCapability(caps().commands)}</div>
                          <div>Config: {formatCapability(caps().config)}</div>
                        </div>
                      )}
                    </Show>
                  </div>

                  <div class="grid md:grid-cols-2 gap-4">
                    <div class="bg-gray-1 border border-gray-6 rounded-xl p-4">
                      <div class="text-xs text-gray-10 mb-2">Pending permissions</div>
                      <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                        {props.safeStringify(props.pendingPermissions)}
                      </pre>
                    </div>
                    <div class="bg-gray-1 border border-gray-6 rounded-xl p-4">
                      <div class="text-xs text-gray-10 mb-2">Recent events</div>
                      <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                        {props.safeStringify(props.events)}
                      </pre>
                    </div>
                  </div>

                  <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                    <div class="flex items-center justify-between gap-3">
                      <div class="text-sm font-medium text-gray-12">Audit log</div>
                      <div class={`text-xs px-2 py-1 rounded-full border ${openworkAuditStatusStyle()}`}>
                        {openworkAuditStatusLabel()}
                      </div>
                    </div>
                    <Show when={props.openworkAuditError}>
                      <div class="text-xs text-red-11">{props.openworkAuditError}</div>
                    </Show>
                    <Show
                      when={props.openworkAuditEntries.length > 0}
                      fallback={<div class="text-xs text-gray-9">No audit entries yet.</div>}
                    >
                      <div class="divide-y divide-gray-6/50">
                        <For each={props.openworkAuditEntries}>
                          {(entry) => (
                            <div class="flex items-start justify-between gap-4 py-2">
                              <div class="min-w-0">
                                <div class="text-sm text-gray-12 truncate">{entry.summary}</div>
                                <div class="text-[11px] text-gray-9 truncate">
                                  {entry.action} · {entry.target} · {formatActor(entry)}
                                </div>
                              </div>
                              <div class="text-[11px] text-gray-9 whitespace-nowrap">
                                {entry.timestamp ? formatRelativeTime(entry.timestamp) : "—"}
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </div>
              </div>
            </section>
          </Show>
        </Match>
      </Switch>
    </section>
  );
}
