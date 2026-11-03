import { useQuery } from "@tanstack/react-query";
import type { BrowserSpeechRecognition } from "@openwork/ui/react";
import { desktopBridge, type SpeechDictationEvent } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/lib/runtime-env";

const titles = {
  local: "Dictate message · Transcribed on this device",
  online: "Dictate message · Windows online speech recognition transcribes it",
} as const;

/** The desktop reports a speech helper only when this build ships one (and, on
 * macOS, the speech permission text); otherwise system dictation stays. */
export function useDesktopSpeechDictation() {
  const query = useQuery({
    queryKey: ["desktop", "speech-dictation"],
    queryFn: () => desktopBridge.__speechDictationMode(),
    enabled: isDesktopRuntime(),
    staleTime: Infinity,
    retry: false,
  });
  return query.data ? { recognition: DesktopSpeechRecognition, recognitionTitle: titles[query.data] } : {};
}

/** Web Speech-shaped adapter over the desktop recognizer, so the composer's
 * dictation session keeps owning insertion, revisions and late-result fencing. */
export class DesktopSpeechRecognition implements BrowserSpeechRecognition {
  lang = "en-US";
  continuous = true;
  interimResults = true;
  onstart: BrowserSpeechRecognition["onstart"] = null;
  onend: BrowserSpeechRecognition["onend"] = null;
  onerror: BrowserSpeechRecognition["onerror"] = null;
  onresult: BrowserSpeechRecognition["onresult"] = null;
  private readonly id = crypto.randomUUID();
  private unsubscribe: (() => void) | null = null;

  start() {
    const subscribe = window.__OPENWORK_ELECTRON__?.dictation?.onEvent;
    if (!subscribe) throw new Error("Desktop speech dictation is unavailable");
    this.unsubscribe = subscribe(event => this.receive(event));
    void desktopBridge.__startSpeechDictation(this.id, this.lang)
      .then(result => result.ok ? undefined : this.fail())
      .catch(() => this.fail());
  }

  stop() { void desktopBridge.__stopSpeechDictation(this.id).catch(() => {}) }

  abort() {
    void desktopBridge.__abortSpeechDictation(this.id).catch(() => {});
    this.close();
  }

  private fail() {
    this.receive({ id: this.id, type: "error", code: "network" });
    this.receive({ id: this.id, type: "end" });
  }

  private close() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private receive(event: SpeechDictationEvent) {
    if (event.id !== this.id || !this.unsubscribe) return;
    if (event.type === "ready") this.onstart?.();
    else if (event.type === "result") this.onresult?.({ results: event.segments.map(transcript => [{ transcript }]) });
    else if (event.type === "error") this.onerror?.({ error: event.code });
    else { this.close(); this.onend?.() }
  }
}
