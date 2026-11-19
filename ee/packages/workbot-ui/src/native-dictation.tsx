import { Button } from "@base-ui/react/button";
import { CircleAlert, Mic, MicOff } from "lucide-react";
import { DictationWaveform, type useNativeDictation } from "@openwork/ui/react";

export function WorkbotDictation({ dictation, disabled, text }: {
  dictation: ReturnType<typeof useNativeDictation>;
  disabled?: boolean;
  text: string;
}) {
  const stopping = dictation.state === "listening";
  return <div className="flex shrink-0 items-center gap-1">
    {dictation.active ? <DictationWaveform text={text} className="h-6 w-14 shrink-0 text-[var(--wb-muted)] [&_rect]:transition-transform [&_rect]:duration-150 [&_rect]:ease-out motion-reduce:[&_rect]:transition-none" /> : null}
    <Button type="button" disabled={disabled || dictation.busy} aria-disabled={!dictation.available || undefined}
      aria-label={stopping ? "Stop dictation" : "Dictate message"} title={dictation.title} aria-busy={dictation.busy || undefined} data-native-dictation
      onPointerDown={event => event.preventDefault()} onClick={() => { void dictation.toggle() }}
      className="grid size-9 shrink-0 place-items-center rounded-md text-[var(--wb-muted)] transition-colors duration-150 hover:text-[var(--wb-text)] aria-disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
      {dictation.error ? <CircleAlert size={16} strokeWidth={1.5} /> : stopping ? <MicOff size={16} strokeWidth={1.5} /> : <Mic size={16} strokeWidth={1.5} />}
    </Button>
    {dictation.error ? <span role="alert" className="sr-only">{dictation.error}</span> : null}
  </div>;
}
