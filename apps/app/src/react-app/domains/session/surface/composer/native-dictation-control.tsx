import { CircleAlert, Mic, MicOff, Square, X } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { DictationWaveform, type useNativeDictation } from "@openwork/ui/react";
import { Button } from "@/components/ui/button";
import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { ProgressIndicator, ProgressTrack, ProgressValue } from "@/components/ui/progress";

export function NativeDictationControl({ dictation, disabled, text }: {
  dictation: ReturnType<typeof useNativeDictation>;
  disabled?: boolean;
  text: string;
}) {
  if (dictation.local) return <LocalDictationControl dictation={dictation} disabled={disabled} />;
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

// Keep the main button mounted, so Stop returns to Mic without moving focus.
// Visual transitions never delay capture, cancellation, or submission.
function LocalDictationControl({ dictation, disabled }: {
  dictation: ReturnType<typeof useNativeDictation>;
  disabled?: boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const levels = useSyncExternalStore(dictation.meter.subscribe, dictation.meter.getSnapshot, dictation.meter.getSnapshot);
  const recording = dictation.localRecording;
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!recording && restoreFocus.current) {
      restoreFocus.current = false;
      button.current?.focus();
    }
  }, [recording]);
  // Retain the outgoing phase during collapse instead of flashing "Listening".
  const phase = useRef<{ listening: boolean; preparing: boolean; installing: boolean; progress: number | null; status: string }>({
    listening: false, preparing: false, installing: false, progress: null, status: "Starting dictation",
  });
  if (recording) phase.current = {
    listening: dictation.state === "listening",
    preparing: dictation.state === "starting" && !dictation.installingModel,
    installing: dictation.installingModel,
    progress: dictation.modelDownloadProgress,
    status: dictation.installingModel ? "Downloading speech model" : dictation.state === "starting" ? "Starting dictation" : dictation.state === "stopping" ? "Finishing dictation" : "Listening",
  };
  const { listening, preparing, installing, progress, status } = phase.current;
  const icon = dictation.error ? "error" : recording && dictation.state !== "starting" ? "stop" : "mic";
  const iconMotion = "col-start-1 row-start-1 transition-[opacity,scale,translate] duration-150 ease-out motion-reduce:transition-none motion-reduce:scale-100 motion-reduce:translate-y-0";
  const feedback = "rounded-md text-dls-secondary hover:bg-muted/50 hover:text-foreground transition-[background-color,color,opacity,scale] duration-150 ease-out enabled:active:scale-95 motion-reduce:enabled:active:scale-100 motion-reduce:transition-none motion-reduce:scale-100 motion-reduce:translate-y-0";
  return <div data-dictation-recording={recording ? "" : undefined} className="flex h-9 shrink-0 items-center">
    <div data-dictation-expansion inert={!recording} aria-hidden={!recording}
      className={`overflow-hidden transition-[width,opacity] ease-out motion-reduce:transition-none ${recording ? "w-36 opacity-100 duration-180" : "w-0 opacity-0 duration-120"}`}>
      <div className="flex h-9 w-36 items-center gap-1.5 pr-1.5">
        <Button type="button" variant="ghost" size="icon" aria-label="Cancel dictation" title="Cancel dictation · Esc"
          className={`${feedback} focus-visible:ring-inset`} tabIndex={recording ? 0 : -1}
          onPointerDown={event => event.preventDefault()} onClick={event => {
            restoreFocus.current = document.activeElement === event.currentTarget;
            dictation.cancel();
          }}>
          <X size={16} strokeWidth={1.5} />
        </Button>
        <div className="grid h-9 w-24 shrink-0 place-items-center">
          <div className="contents" aria-hidden="true">
            <DictationWaveform text="" levels={levels} preparing={preparing && recording}
              className={`col-start-1 row-start-1 h-5 w-24 text-dls-secondary transition-[opacity,scale,translate] duration-150 ease-out motion-reduce:hidden ${listening || preparing ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"}`} />
            <span className={`col-start-1 row-start-1 w-24 text-center text-xs leading-4 text-dls-secondary transition-[opacity,scale,translate] duration-150 ease-out motion-reduce:transition-none motion-reduce:scale-100 motion-reduce:translate-y-0 ${installing ? "opacity-0" : listening || preparing ? "-translate-y-1 opacity-0 motion-reduce:opacity-100" : "translate-y-0 opacity-100"}`}>
              {status}
            </span>
          </div>
          <ProgressPrimitive.Root value={progress === null ? null : Math.round(progress * 100)}
            aria-label="Downloading speech model" aria-hidden={!installing || !recording} title="Downloading speech model"
            className={`col-start-1 row-start-1 grid w-24 gap-1 transition-opacity duration-150 ease-out motion-reduce:transition-none ${installing ? "opacity-100" : "opacity-0"}`}>
            <div className="flex items-center justify-between text-xs leading-4 text-dls-secondary" aria-hidden="true">
              <span>Download</span><ProgressValue className="text-xs leading-4 text-dls-secondary" />
            </div>
            <ProgressTrack className="h-1.5">
              <ProgressIndicator className={`rounded-full transition-[width] duration-150 ease-out data-[indeterminate]:w-1/3 motion-reduce:transition-none motion-reduce:animate-none ${recording && installing && progress === null ? "animate-pulse" : ""}`} />
            </ProgressTrack>
          </ProgressPrimitive.Root>
        </div>
      </div>
    </div>
    <Button ref={button} type="button" variant="ghost" size="icon" data-native-dictation
      aria-label={recording ? "Stop dictation" : "Dictate message"} title={dictation.busy ? status : dictation.title}
      disabled={dictation.busy || (!recording && disabled)} aria-busy={dictation.busy || undefined}
      className={feedback} onPointerDown={event => event.preventDefault()} onClick={() => { void dictation.toggle() }}>
      <span className="grid place-items-center" aria-hidden="true">
        <Mic size={16} strokeWidth={1.5} className={`${iconMotion} ${icon === "mic" ? "scale-100 opacity-100" : "scale-75 opacity-0"}`} />
        <Square size={16} strokeWidth={1.5} fill="currentColor" className={`${iconMotion} ${icon === "stop" ? "scale-100 opacity-100" : "scale-75 opacity-0"}`} />
        <CircleAlert size={16} strokeWidth={1.5} className={`${iconMotion} ${icon === "error" ? "scale-100 opacity-100" : "scale-75 opacity-0"}`} />
      </span>
    </Button>
    <span role="status" className="sr-only">{recording ? status : ""}</span>
    {dictation.error ? <span role="alert" className="sr-only">{dictation.error}</span> : null}
  </div>;
}
