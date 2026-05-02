/** @jsxImportSource react */
import { useCallback, useEffect, useId, useState } from "react";
import { ArrowUpRight, Eye, EyeOff, Mic2, Trash2, Volume2 } from "lucide-react";

import type { OpenworkServerClient } from "../../../../app/lib/openwork-server";
import { t } from "../../../../i18n";
import { Button } from "../../../design-system/button";
import { TextInput } from "../../../design-system/text-input";
import {
  readRealtimeControlMicPreference,
  readRealtimeControlTranscriptPanelEnabled,
  writeRealtimeControlMicPreference,
  writeRealtimeControlTranscriptPanelEnabled,
  type RealtimeControlMicPreference,
} from "../state/realtime-control-preferences";

const OPENAI_API_KEY = "OPENAI_API_KEY";
const settingsPanelClass = "rounded-[28px] border border-dls-border bg-dls-surface p-5 md:p-6";
const settingsPanelSoftClass = "rounded-2xl bg-gray-1/45 p-4";
const MICROPHONE_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

type EnvItem = { key: string; value: string; updatedAt: number };

export type FeaturePreviewViewProps = {
  client: OpenworkServerClient | null;
  realtimeControlEnabled: boolean;
  onToggleRealtimeControl: () => void;
};

function maskValue(value: string) {
  if (!value) return "";
  if (value.length <= 10) return "••••••••";
  return `${value.slice(0, 7)}••••${value.slice(-4)}`;
}

export function FeaturePreviewView(props: FeaturePreviewViewProps) {
  const inputId = useId();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [savedKey, setSavedKey] = useState<EnvItem | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [micPreference, setMicPreference] = useState<RealtimeControlMicPreference>(readRealtimeControlMicPreference);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [micLoading, setMicLoading] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [micTestBusy, setMicTestBusy] = useState(false);
  const [micTestStatus, setMicTestStatus] = useState<string | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const [transcriptPanelEnabled, setTranscriptPanelEnabled] = useState(readRealtimeControlTranscriptPanelEnabled);

  const refresh = useCallback(async () => {
    if (!props.client) {
      setSavedKey(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await props.client.listUserEnv();
      setSavedKey(response.items.find((item) => item.key === OPENAI_API_KEY) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.unknown_error"));
    } finally {
      setLoading(false);
    }
  }, [props.client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveKey = async () => {
    if (!props.client || saving) return;
    const value = draft.trim();
    if (!value) {
      setError(t("settings.feature_preview.openai_key_required"));
      return;
    }
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      await props.client.upsertUserEnv([{ key: OPENAI_API_KEY, value }]);
      setDraft("");
      setRevealed(false);
      setStatus(t("settings.feature_preview.openai_key_saved"));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.unknown_error"));
    } finally {
      setSaving(false);
    }
  };

  const deleteKey = async () => {
    if (!props.client || !savedKey || deleting) return;
    setDeleting(true);
    setError(null);
    setStatus(null);
    try {
      await props.client.deleteUserEnv(OPENAI_API_KEY);
      setSavedKey(null);
      setStatus(t("settings.feature_preview.openai_key_removed"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.unknown_error"));
    } finally {
      setDeleting(false);
    }
  };

  const refreshMicrophones = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setMicError("Microphone device selection is not available in this browser context.");
      return;
    }
    setMicLoading(true);
    setMicError(null);
    try {
      // Ask for a temporary stream first so Chromium can reveal device labels.
      const requestMicrophone = window.__OPENWORK_ELECTRON__?.permissions?.requestMicrophone;
      if (requestMicrophone) {
        const result = await requestMicrophone();
        if (result.granted === false) {
          throw new Error(`Microphone permission is ${result.status || "not granted"}. Enable it in macOS Privacy & Security settings.`);
        }
      }
      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } finally {
        stream?.getTracks().forEach((track) => track.stop());
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      setMicDevices(devices.filter((device) => device.kind === "audioinput"));
    } catch (err) {
      setMicError(err instanceof Error ? err.message : "Could not read microphone devices.");
    } finally {
      setMicLoading(false);
    }
  };

  const requestMacMicrophonePermission = async () => {
    const requestMicrophone = window.__OPENWORK_ELECTRON__?.permissions?.requestMicrophone;
    if (!requestMicrophone) return "browser";
    const result = await requestMicrophone();
    if (result.granted === false) {
      throw new Error(`Microphone permission is ${result.status || "not granted"}. Enable it in macOS Privacy & Security settings, then quit and reopen OpenWork.`);
    }
    return result.status || "granted";
  };

  const selectedAudioConstraints = (): MediaStreamConstraints => ({
    audio: {
      ...(micPreference.deviceId ? { deviceId: { exact: micPreference.deviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const testMicrophone = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicError("Microphone testing is not available in this browser context.");
      return;
    }
    setMicTestBusy(true);
    setMicError(null);
    setMicTestStatus(null);
    setMicLevel(0);
    let stream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    let frame = 0;
    try {
      const permission = await requestMacMicrophonePermission();
      stream = await navigator.mediaDevices.getUserMedia(selectedAudioConstraints());
      const track = stream.getAudioTracks()[0];
      if (!track || track.readyState !== "live") {
        throw new Error("OpenWork could not start a live microphone track.");
      }
      const label = track.label || micPreference.label || "System default";
      audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const startedAt = Date.now();
      let peak = 0;
      await new Promise<void>((resolve) => {
        const tick = () => {
          analyser.getByteTimeDomainData(samples);
          let sum = 0;
          for (const sample of samples) {
            const centered = sample - 128;
            sum += centered * centered;
          }
          const rms = Math.sqrt(sum / samples.length) / 128;
          peak = Math.max(peak, rms);
          setMicLevel(Math.min(1, rms * 6));
          if (Date.now() - startedAt >= 3500) {
            resolve();
            return;
          }
          frame = window.requestAnimationFrame(tick);
        };
        tick();
      });
      setMicTestStatus(
        peak > 0.015
          ? `Audio detected from ${label}. Permission: ${permission}.`
          : `Mic track is live from ${label}, but no audio was detected. Check input volume or choose another microphone. Permission: ${permission}.`,
      );
    } catch (err) {
      setMicError(err instanceof Error ? err.message : "Microphone test failed.");
    } finally {
      if (frame) window.cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      await audioContext?.close().catch(() => undefined);
      setMicTestBusy(false);
    }
  };

  const openMicrophoneSettings = () => {
    const openExternal = window.__OPENWORK_ELECTRON__?.shell?.openExternal;
    if (openExternal) {
      void openExternal(MICROPHONE_SETTINGS_URL);
      return;
    }
    window.open(MICROPHONE_SETTINGS_URL, "_blank", "noopener,noreferrer");
  };

  const toggleTranscriptPanel = () => {
    const next = !transcriptPanelEnabled;
    setTranscriptPanelEnabled(next);
    writeRealtimeControlTranscriptPanelEnabled(next);
  };

  const selectMicrophone = (deviceId: string) => {
    const device = micDevices.find((item) => item.deviceId === deviceId);
    const next = {
      deviceId,
      label: deviceId ? (device?.label || "Selected microphone") : "System default",
    };
    setMicPreference(next);
    writeRealtimeControlMicPreference(next);
  };

  return (
    <div className="space-y-6">
      <div className={`${settingsPanelClass} space-y-5`}>
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="max-w-[58ch] space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full bg-[rgba(var(--dls-accent-rgb),0.1)] px-3 py-1 text-[11px] font-medium text-dls-accent">
              <Mic2 size={13} />
              {t("settings.feature_preview.badge")}
            </div>
            <div>
              <div className="text-sm font-medium text-gray-12">
                {t("settings.feature_preview.realtime_title")}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-gray-10">
                {t("settings.feature_preview.realtime_description")}
              </p>
            </div>
          </div>
          <Button
            variant={props.realtimeControlEnabled ? "primary" : "outline"}
            className="h-9 shrink-0 rounded-full px-4 py-0 text-xs"
            onClick={props.onToggleRealtimeControl}
          >
            {props.realtimeControlEnabled ? t("settings.feature_preview.enabled") : t("settings.feature_preview.disabled")}
          </Button>
        </div>

        <div className={`${settingsPanelSoftClass} space-y-4`}>
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-12">
                {t("settings.feature_preview.openai_key_title")}
              </div>
              <div className="mt-1 text-xs leading-relaxed text-gray-10">
                {t("settings.feature_preview.openai_key_description")}
              </div>
            </div>
            <div className="shrink-0 rounded-full bg-gray-3/80 px-3 py-1 text-[11px] font-medium text-gray-10">
              {loading
                ? t("settings.feature_preview.checking")
                : savedKey
                  ? t("settings.feature_preview.configured")
                  : t("settings.feature_preview.not_configured")}
            </div>
          </div>

          {savedKey ? (
            <div className="flex flex-col gap-3 rounded-2xl bg-dls-surface/65 p-3 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <div className="text-xs font-medium text-gray-11">{OPENAI_API_KEY}</div>
                <div className="mt-1 truncate font-mono text-xs text-gray-8">
                  {revealed ? savedKey.value : maskValue(savedKey.value)}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-1.5 rounded-full bg-gray-2 px-3 text-xs text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
                  onClick={() => setRevealed((value) => !value)}
                >
                  {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
                  {revealed ? t("settings.environment.hide") : t("settings.environment.reveal")}
                </button>
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-1.5 rounded-full bg-red-3/45 px-3 text-xs text-red-10 transition-colors hover:bg-red-4/70 hover:text-red-11 disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => void deleteKey()}
                  disabled={deleting}
                >
                  <Trash2 size={13} />
                  {deleting ? t("settings.environment.deleting") : t("settings.environment.delete")}
                </button>
              </div>
            </div>
          ) : null}

          <div className="space-y-3">
            <TextInput
              id={inputId}
              type="password"
              autoComplete="off"
              label={savedKey ? t("settings.feature_preview.replace_key") : t("settings.feature_preview.openai_key_label")}
              placeholder="sk-…"
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              disabled={!props.client || saving}
              hint={t("settings.feature_preview.openai_key_hint")}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                className="h-8 rounded-full px-3 py-0 text-xs"
                onClick={() => void saveKey()}
                disabled={!props.client || saving || !draft.trim()}
              >
                {saving ? t("settings.environment.saving") : t("settings.environment.save")}
              </Button>
              {!props.client ? (
                <span className="text-xs text-gray-9">
                  {t("settings.feature_preview.connect_server_hint")}
                </span>
              ) : null}
            </div>
          </div>

          {status ? <div className="text-xs text-green-11">{status}</div> : null}
          {error ? <div className="text-xs text-red-11">{error}</div> : null}
        </div>

        <div className={`${settingsPanelSoftClass} space-y-4`}>
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-12">Microphone input</div>
              <div className="mt-1 text-xs leading-relaxed text-gray-10">
                Choose and test the microphone Realtime control should use before starting voice mode. System default follows your macOS/browser default input device.
              </div>
              <div className="mt-1 truncate text-[11px] text-gray-8">
                Current: {micPreference.label || "System default"}
              </div>
            </div>
            <Button
              variant="outline"
              className="h-8 shrink-0 rounded-full px-3 py-0 text-xs"
              onClick={() => void refreshMicrophones()}
              disabled={micLoading}
            >
              {micLoading ? "Checking…" : "Refresh microphones"}
            </Button>
          </div>

          <label className="block">
            <div className="mb-1 text-xs font-medium text-dls-secondary">Input device</div>
            <select
              className="w-full rounded-lg border border-dls-border bg-dls-surface px-3 py-2 text-sm text-dls-text shadow-sm focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
              value={micPreference.deviceId}
              onChange={(event) => selectMicrophone(event.currentTarget.value)}
            >
              <option value="">System default</option>
              {micDevices.map((device, index) => (
                <option key={device.deviceId || `mic-${index}`} value={device.deviceId}>
                  {device.label || `Microphone ${index + 1}`}
                </option>
              ))}
            </select>
          </label>

          <div className="space-y-2 rounded-2xl bg-dls-surface/65 p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2 text-xs text-gray-10">
                <Volume2 size={14} className="text-gray-9" />
                <span>{micTestBusy ? "Speak now — testing microphone input…" : micTestStatus ?? "Run a quick test to confirm OpenWork can actually hear audio."}</span>
              </div>
              <Button
                variant="secondary"
                className="h-8 shrink-0 rounded-full px-3 py-0 text-xs"
                onClick={() => void testMicrophone()}
                disabled={micTestBusy}
              >
                {micTestBusy ? "Testing…" : "Test microphone"}
              </Button>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-gray-4/70">
              <div
                className="h-full rounded-full bg-[rgba(var(--dls-accent-rgb),0.75)] transition-[width] duration-75"
                style={{ width: `${Math.round(micLevel * 100)}%` }}
              />
            </div>
          </div>

          {micDevices.length === 0 ? (
            <div className="text-xs text-gray-9">
              Click “Refresh microphones” to grant device-list access and see available inputs.
            </div>
          ) : null}
          {micError ? (
            <div className="space-y-3 rounded-2xl bg-red-2/55 p-3 text-xs text-red-11">
              <div>{micError}</div>
              <div className="leading-relaxed text-red-10">
                If macOS shows permission as denied, open Microphone settings, enable OpenWork, then fully quit and reopen the app. macOS will not show the prompt again after a denial.
              </div>
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-red-4/60 px-3 text-xs font-medium text-red-11 transition-colors hover:bg-red-5/70"
                onClick={openMicrophoneSettings}
              >
                Open Microphone Settings
                <ArrowUpRight size={13} />
              </button>
            </div>
          ) : null}
        </div>

        <div className={`${settingsPanelSoftClass} flex flex-col gap-3 md:flex-row md:items-center md:justify-between`}>
          <div className="min-w-0">
            <div className="text-sm font-medium text-gray-12">Transcript panel</div>
            <div className="mt-1 text-xs leading-relaxed text-gray-10">
              Show a right-side panel during voice control with spoken input, model output, and tool-call activity.
            </div>
          </div>
          <Button
            variant={transcriptPanelEnabled ? "primary" : "outline"}
            className="h-8 shrink-0 rounded-full px-3 py-0 text-xs"
            onClick={toggleTranscriptPanel}
          >
            {transcriptPanelEnabled ? "Shown" : "Hidden"}
          </Button>
        </div>
      </div>
    </div>
  );
}
