import type { VoiceController } from "@/ui/use-voice";
import { Button } from "@/ui/kit";

function VoiceIcon() {
  return <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 8v4m3-7v10m4-13v16m4-13v10m3-7v4" /></svg>;
}

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/60 motion-reduce:transition-none";

export function VoiceToggle({ voice, disabled = false }: { voice: VoiceController; disabled?: boolean }) {
  return <button ref={voice.toggleRef} type="button" aria-label="Voice mode" title="Voice mode" aria-pressed={voice.enabled} aria-busy={voice.phase === "checking"} disabled={disabled} onClick={(event) => void voice.toggle(event.currentTarget)} data-testid="voice-toggle"
    className={`flex size-8 shrink-0 items-center justify-center rounded-full border transition-colors disabled:opacity-40 ${focusRing} ${voice.enabled ? "border-spark/50 bg-spark/15 text-spark" : "border-line text-mist hover:border-spark/40 hover:text-snow"}`}><VoiceIcon /></button>;
}

export function VoicePanel({ voice }: { voice: VoiceController }) {
  const recording = voice.phase === "recording";
  const permission = voice.phase === "permission";
  const speaking = voice.phase === "speaking" || voice.phase === "preparing";
  const membership = voice.access === "membership_required" || voice.access === "sign_in";
  return <>
    {membership ? <section className="mb-3 rounded-2xl border border-spark/20 bg-spark/5 p-4" data-testid="voice-membership">
      <div className="flex items-center gap-2 text-spark"><VoiceIcon /><h3 className="text-sm font-medium text-snow">Voice mode, with OpenWork Models</h3></div>
      <p className="mt-2 text-xs leading-5 text-mist">Talk through an idea or dictate a message. Listen to short replies and read along, without leaving your conversation.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={voice.openModels} className="text-xs">Explore Models membership</Button>
        {voice.access === "sign_in" ? <Button variant="ghost" onClick={voice.signIn}>Sign in</Button> : null}
      </div>
      <p className="mt-2 text-[11px] text-mist">{voice.access === "sign_in" ? "Sign in to check your access." : "An active Models membership is required."} Your answer model stays the same.</p>
    </section> : null}
    {voice.access === "unavailable" ? <div className="mb-3 rounded-xl border border-line p-3 text-xs text-mist" data-testid="voice-unavailable">Voice is unavailable right now, not necessarily unsubscribed. Keep typing or <button type="button" className={`rounded text-snow underline ${focusRing}`} onClick={() => void voice.toggle()}>check again</button>.</div> : null}
    {voice.enabled ? <div ref={voice.panelRef} tabIndex={0} role="group" aria-label="Voice recording controls. Hold Space to record; release to review. Escape cancels." className={`mb-3 rounded-2xl border border-line bg-black/15 p-3 ${focusRing}`} data-testid="voice-panel" data-phase={voice.phase}>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" aria-label={recording ? "Finish recording" : permission ? "Cancel microphone request" : "Record message"} aria-pressed={recording} disabled={voice.phase === "transcribing"}
          onClick={recording || permission ? voice.finishRecording : voice.startRecording}
          className={`flex size-10 shrink-0 items-center justify-center rounded-full ${focusRing} ${recording ? "bg-rose/20 text-rose" : "bg-spark/15 text-spark"} disabled:opacity-40`} data-testid="voice-record">
          {recording || permission ? <svg viewBox="0 0 20 20" className="size-4 fill-current" aria-hidden="true"><rect x="4" y="4" width="12" height="12" rx="3" /></svg> : <svg viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><rect x="7" y="2" width="6" height="10" rx="3" /><path d="M4 9v1a6 6 0 0 0 12 0V9m-6 7v2m-3 0h6" /></svg>}
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-snow">{recording ? "Your message" : permission ? "Microphone permission" : voice.phase === "transcribing" ? "Making your draft" : speaking ? "Listen and read along" : "Record a message"}</p>
          {recording ? <div className="mt-1 flex h-5 items-center gap-0.5" aria-hidden="true" data-testid="voice-levels">{voice.levels.map((level, index) => <span key={index} className="w-1 rounded-full bg-rose/75" style={{ height: `${2 + level * 18}px` }} />)}</div> : <p className="mt-1 text-[11px] text-mist">Click the mic, or focus here and hold Space.</p>}
        </div>
        {recording ? <span className="text-xs tabular-nums text-mist" aria-label="Recording time" data-testid="voice-timer">{Math.floor(voice.elapsed / 60)}:{String(voice.elapsed % 60).padStart(2, "0")} / 1:00</span> : null}
        {voice.phase !== "idle" ? <button type="button" onClick={() => voice.stop(speaking ? "Speech stopped. Your coworker can keep working." : "Recording cancelled. Your draft is kept.", true)} className={`rounded-full border border-line px-3 py-1.5 text-xs text-mist hover:text-snow ${focusRing}`} data-testid="voice-cancel">{speaking ? "Stop audio" : "Cancel"}</button> : null}
      </div>
      {voice.caption ? <div className="mt-3 border-t border-line pt-3" data-testid="voice-caption" aria-live="off"><p className="text-[10px] text-mist">Sentence captions</p><p className="mt-1 text-sm leading-relaxed text-snow">{voice.caption}</p></div> : null}
      {voice.truncated ? <p className="mt-2 text-[11px] text-mist">Short spoken preview. Read the rest in the transcript.</p> : null}
      <p className="mt-3 text-[10px] leading-4 text-mist">AI-generated voice. Audio and reply text are processed through OpenRouter.</p>
    </div> : null}
    <p role="status" aria-live="polite" aria-atomic="true" className={voice.status ? "mb-2 px-1 text-[11px] text-mist" : "sr-only"} data-testid="voice-status">{voice.status}</p>
  </>;
}
