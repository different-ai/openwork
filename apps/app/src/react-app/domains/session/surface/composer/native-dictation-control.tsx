import { CircleAlert, Mic, MicOff, Square, X } from "lucide-react";
import { useSyncExternalStore } from "react";
import { DictationWaveform, type useNativeDictation } from "@openwork/ui/react";
import { Button } from "@/components/ui/button";

export function NativeDictationControl({ dictation, disabled, text }: {
  dictation: ReturnType<typeof useNativeDictation>;
  disabled?: boolean;
  text: string;
}) {
  if (dictation.buffering) return null;
  const stopping = dictation.state === "listening";
  return <div className="flex items-center gap-1.5">
    {dictation.active ? <DictationWaveform text={text} className="h-6 w-16 shrink-0 text-dls-secondary [&_rect]:transition-transform [&_rect]:duration-150 [&_rect]:ease-out motion-reduce:[&_rect]:transition-none" /> : null}
    <Button type="button" variant="ghost" size="icon" disabled={disabled || dictation.busy}
      aria-disabled={!dictation.available || undefined} aria-label={stopping ? "Stop dictation" : "Dictate message"}
      title={dictation.title} aria-busy={dictation.busy || undefined} data-native-dictation
      className="rounded-md text-dls-secondary hover:text-foreground aria-disabled:opacity-50"
      onPointerDown={event => event.preventDefault()} onClick={() => { void dictation.toggle() }}>
      {dictation.error ? <CircleAlert size={16} strokeWidth={1.5} /> : stopping ? <MicOff size={16} strokeWidth={1.5} /> : <Mic size={16} strokeWidth={1.5} />}
    </Button>
    {dictation.error ? <span role="alert" className="sr-only">{dictation.error}</span> : null}
  </div>;
}

/** Uses the existing microphone stream; no generated movement or interim words. */
export function NativeDictationRecording({ dictation }: { dictation: ReturnType<typeof useNativeDictation> }) {
  const levels = useSyncExternalStore(dictation.meter.subscribe, dictation.meter.getSnapshot, dictation.meter.getSnapshot);
  if (!dictation.buffering) return null;
  const status = dictation.state === "starting" ? "Starting dictation" : dictation.state === "stopping" ? "Finishing dictation" : "Listening";
  return <div data-dictation-recording className="flex min-w-0 items-center gap-3 py-2">
    <Button type="button" variant="ghost" size="icon" aria-label="Cancel dictation" title="Cancel dictation · Esc"
      onPointerDown={event => event.preventDefault()} onClick={dictation.cancel}>
      <X size={16} strokeWidth={1.5} />
    </Button>
    <DictationWaveform text="" levels={levels} className="h-8 min-w-0 flex-1 text-dls-secondary motion-reduce:hidden" />
    <span role="status" className={dictation.state === "listening" ? "sr-only motion-reduce:not-sr-only motion-reduce:flex-1" : "text-xs text-dls-secondary"}>{status}</span>
    <Button type="button" variant="ghost" size="icon" aria-label="Stop dictation" title="Stop dictation"
      disabled={dictation.busy} aria-busy={dictation.busy || undefined}
      onPointerDown={event => event.preventDefault()} onClick={() => { void dictation.toggle() }}>
      <Square size={16} strokeWidth={1.5} fill="currentColor" />
    </Button>
  </div>;
}
