import { CircleAlert, Mic, MicOff } from "lucide-react";
import { DictationWaveform, type useNativeDictation } from "@openwork/ui/react";
import { Button } from "@/components/ui/button";

export function NativeDictationControl({ dictation, disabled, text }: {
  dictation: ReturnType<typeof useNativeDictation>;
  disabled?: boolean;
  text: string;
}) {
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
