/** @jsxImportSource react */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Loader2, Mic2, MicOff, Radio, Square, VolumeX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ComposerDraft } from "@/app/types";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import type { CloudMcpSubmissionResult } from "../../connections/cloud-mcp-submit-readiness";
import { useSessionActivityStore } from "../status/session-activity-store";
import { useControlAction, type OpenworkControlAction } from "../../../shell/control/control-provider";
import { VoiceSession } from "./voice-session";

type VoicePanelProps = {
  client: OpenworkServerClient;
  sessionId: string;
  workspaceId: string;
  workspaceRoot: string;
  opencodeBaseUrl: string;
  openworkToken: string;
  needsScreen: boolean;
  onSendDraft: (draft: ComposerDraft, sessionId: string) => Promise<CloudMcpSubmissionResult>;
  onClose: () => void;
};

function Control(props: { action: OpenworkControlAction }) { useControlAction(props.action); return null; }

export function VoicePanel(props: VoicePanelProps) {
  const latest = useRef(props);
  latest.current = props;
  const session = useMemo(() => new VoiceSession({
    sessionId: props.sessionId,
    workspaceId: props.workspaceId,
    workspaceRoot: props.workspaceRoot,
    opencodeBaseUrl: props.opencodeBaseUrl,
    token: props.openworkToken,
    client: props.client,
    isCurrent: () => latest.current.sessionId === props.sessionId && latest.current.workspaceId === props.workspaceId && latest.current.opencodeBaseUrl === props.opencodeBaseUrl && latest.current.openworkToken === props.openworkToken,
    needsScreen: () => latest.current.needsScreen || useSessionActivityStore.getState().getStatus(props.workspaceId, props.sessionId) === "waiting",
    submit: (draft, id) => latest.current.onSendDraft(draft, id),
  }), [props.sessionId, props.workspaceId, props.workspaceRoot, props.opencodeBaseUrl, props.openworkToken, props.client]);
  useLayoutEffect(() => () => session.dispose(), [session]);
  const state = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot, session.store.getSnapshot);
  const [text, setText] = useState("");
  const timelineEnd = useRef<HTMLDivElement>(null);
  const starting = state.status === "connecting" || state.status === "reconnecting";
  const connected = ["listening", "processing", "speaking", "muted"].includes(state.status);
  useEffect(() => {
    if (state.pendingText) setText(state.pendingText);
  }, [state.pendingText]);
  useEffect(() => { timelineEnd.current?.scrollIntoView({ block: "end" }); }, [state.entries.length]);
  const send = () => {
    if (!text.trim()) return;
    const request = text;
    setText("");
    void session.submitText(request);
  };
  const actions: OpenworkControlAction[] = [
    { id: "voice.start", label: "Start Voice Mode", description: "Start microphone capture for this conversation.", sideEffect: "external", disabled: connected || starting, execute: () => session.start() },
    { id: "voice.stop", label: "End voice", description: "End audio capture and playback; accepted conversation work continues.", sideEffect: "external", execute: session.end },
    { id: "voice.stop_talking", label: "Stop talking", description: "Interrupt speech playback without cancelling work.", sideEffect: "none", execute: session.stopTalking },
    { id: "voice.toggle_mute", label: "Toggle voice microphone", description: "Release or reacquire the microphone. Work continues.", sideEffect: "external", disabled: !connected, execute: session.toggleMute },
    { id: "voice.cancel_operation", label: "Cancel operation", description: "Request cancellation in this conversation and clear its queued follow-ups.", sideEffect: "mutation", execute: session.cancel },
    { id: "voice.send_text", label: "Send text in this conversation", description: "Submit a typed request through the normal conversation sender; no audio provider required.", sideEffect: "mutation", requiresArgs: true, args: [{ name: "text", type: "string", required: true }], execute: (args) => {
      if (typeof args !== "object" || !args || !("text" in args) || typeof args.text !== "string") throw new Error("Text is required");
      return session.submitText(args.text);
    } },
    { id: "voice.status", label: "Read Voice Mode status", description: "Read capture and conversation status without transcript contents.", kind: "query", sideEffect: "none", execute: () => ({
      sessionId: props.sessionId, workspaceId: props.workspaceId, status: state.status,
      captureActive: state.captureActive, micMuted: state.micMuted, working: state.working,
    }) },
  ];
  return (
    <section aria-label="Voice Mode" className="flex h-full min-h-0 flex-col bg-background">
      {actions.map((action) => <Control key={action.id} action={action} />)}
      <header className="flex shrink-0 items-center justify-between border-b px-4 py-3">
        <div><h2 className="flex items-center gap-2 text-sm font-semibold"><Radio className="size-4" />Voice Mode</h2>
          <p className="text-xs text-muted-foreground">Speak and work in this conversation</p></div>
        <Button variant="ghost" size="icon-sm" onClick={() => { session.end(); props.onClose(); }} aria-label="Close Voice Mode"><X /></Button>
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <div className="space-y-3 text-center">
          <div aria-hidden="true" className={cn("mx-auto flex size-20 items-center justify-center rounded-full border bg-muted", state.captureActive && "border-primary bg-primary/10", state.status === "speaking" && "ring-4 ring-primary/20")}>
            {starting ? <Loader2 className="size-7 animate-spin motion-reduce:animate-none" /> : state.captureActive ? <Mic2 className="size-7" /> : <MicOff className="size-7" />}
          </div>
          <p role="status" aria-live="polite" className="text-sm font-medium">{state.statusText}</p>
          <div className="flex justify-center gap-3 text-xs text-muted-foreground">
            <span data-testid="voice-capture-state">{state.captureActive ? "Microphone on" : "Microphone off"}</span>
            {state.working ? <span>Conversation working</span> : null}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={() => void session.start()} disabled={connected || starting}>{starting ? "Connecting…" : state.status === "paused" || state.status === "error" ? "Reconnect voice" : "Start voice"}</Button>
          <Button variant="outline" onClick={session.end} disabled={!connected && !starting}><Square />End voice</Button>
          <Button variant="outline" onClick={() => void session.toggleMute()} disabled={!connected} aria-pressed={state.micMuted}>{state.micMuted ? <Mic2 /> : <MicOff />}{state.micMuted ? "Unmute" : "Mute"}</Button>
          <Button variant="outline" onClick={session.stopTalking} disabled={!connected}><VolumeX />Stop talking</Button>
          <Button variant="outline" className="col-span-2" onClick={() => void session.cancel()}>Cancel operation</Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">Mute turns off microphone capture. End voice or close this panel to end the call; accepted work continues. Cancel operation requests a stop and clears queued follow-ups. Completed changes cannot be undone by cancellation.</p>
        <details className="rounded-lg border p-3 text-xs">
          <summary className="cursor-pointer font-medium">Audio and privacy</summary>
          <div className="mt-3 space-y-3 text-muted-foreground">
            <p>Voice uses OpenAI audio through your configured OpenWork Models service or OpenAI key. Audio and response excerpts go to the voice provider. Accepted transcripts stay in this conversation. OpenWork does not save raw audio.</p>
            <p>Use headphones to reduce echo. If echo cancellation is unavailable, the microphone pauses during speech; use Stop talking to interrupt. For speakers, choose your system output or an output below.</p>
            <p>Approvals and sign-in stay on screen. Never speak passwords, security codes, or other secrets. Background speech cannot approve permission requests. Low-confidence transcripts need review.</p>
            <p>Calls pause after 25 minutes or 5 minutes without speech. Reconnect after a network or system interruption; requests are never automatically replayed.</p>
            <label className="block">Microphone<select aria-label="Voice microphone" className="mt-1 w-full rounded border bg-background p-2 text-foreground" value={state.inputDevice} onChange={(e) => session.setInputDevice(e.currentTarget.value)}>
              <option value="">System default</option>{state.devices.filter((d) => d.kind === "audioinput" && d.id).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select></label>
            {state.outputSelectionSupported ? <label className="block">Speaker<select aria-label="Voice speaker" className="mt-1 w-full rounded border bg-background p-2 text-foreground" value={state.outputDevice} onChange={(e) => void session.setOutputDevice(e.currentTarget.value)}>
              <option value="">System default</option>{state.devices.filter((d) => d.kind === "audiooutput" && d.id).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select></label> : null}
          </div>
        </details>
        <div className="space-y-2">
          <label htmlFor="voice-text" className="text-sm font-medium">{state.pendingText ? "Review before sending" : "Type a request or follow-up"}</label>
          <textarea id="voice-text" aria-label="Voice request" value={text} onChange={(e) => setText(e.currentTarget.value)} maxLength={8000} rows={3} className="w-full resize-y rounded-lg border bg-background p-3 text-sm" placeholder="Describe what you want OpenWork to do…" onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
            if (e.key === "Escape") { e.preventDefault(); session.stopTalking(); }
          }} />
          <div className="flex items-center justify-between gap-2"><span className="text-xs text-muted-foreground">Enter sends · Shift+Enter adds a line · Esc stops speech</span><Button variant="outline" onClick={send} disabled={!text.trim()}>Send request</Button></div>
        </div>
        {state.assistantPreview ? <div className="rounded-lg border bg-muted p-3 text-sm"><p className="mb-1 text-xs text-muted-foreground">Speech transcript · may be interrupted</p>{state.assistantPreview}</div> : null}
        <div aria-label="Voice activity" className="space-y-2">
          {state.entries.map((entry) => <article key={entry.id} className={cn("rounded-lg border p-3 text-sm whitespace-pre-wrap break-words", entry.role === "user" ? "ml-4 bg-primary/5" : entry.role === "system" ? "border-dashed text-xs text-muted-foreground" : "mr-4 bg-muted")}>
            <p className="mb-1 text-xs font-medium">{entry.role === "user" ? "You" : entry.role === "assistant" ? "Spoken response" : "Voice activity"}</p>{entry.text}
          </article>)}
          <div ref={timelineEnd} />
        </div>
      </div>
    </section>
  );
}
