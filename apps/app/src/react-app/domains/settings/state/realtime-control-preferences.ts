const MIC_DEVICE_ID_KEY = "openwork.feature-preview.realtime-control.mic-device-id";
const MIC_DEVICE_LABEL_KEY = "openwork.feature-preview.realtime-control.mic-device-label";
const TRANSCRIPT_PANEL_KEY = "openwork.feature-preview.realtime-control.transcript-panel";

export type RealtimeControlMicPreference = {
  deviceId: string;
  label: string;
};

export function readRealtimeControlMicPreference(): RealtimeControlMicPreference {
  if (typeof window === "undefined") return { deviceId: "", label: "System default" };
  try {
    return {
      deviceId: window.localStorage.getItem(MIC_DEVICE_ID_KEY) ?? "",
      label: window.localStorage.getItem(MIC_DEVICE_LABEL_KEY) ?? "System default",
    };
  } catch {
    return { deviceId: "", label: "System default" };
  }
}

export function writeRealtimeControlMicPreference(preference: RealtimeControlMicPreference) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MIC_DEVICE_ID_KEY, preference.deviceId);
    window.localStorage.setItem(MIC_DEVICE_LABEL_KEY, preference.label || "System default");
    window.dispatchEvent(new CustomEvent("openwork:realtime-control-preferences-changed"));
  } catch {
    // ignore local preference persistence failures
  }
}

export function readRealtimeControlTranscriptPanelEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(TRANSCRIPT_PANEL_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeRealtimeControlTranscriptPanelEnabled(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TRANSCRIPT_PANEL_KEY, enabled ? "1" : "0");
    window.dispatchEvent(new CustomEvent("openwork:realtime-control-preferences-changed"));
  } catch {
    // ignore local preference persistence failures
  }
}

export function subscribeRealtimeControlPreferencesChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => listener();
  window.addEventListener("openwork:realtime-control-preferences-changed", handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener("openwork:realtime-control-preferences-changed", handler);
    window.removeEventListener("storage", handler);
  };
}
