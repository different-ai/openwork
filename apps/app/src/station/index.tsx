/** @jsxImportSource react */
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ArrowRight,
  Captions,
  CornerDownLeft,
  Eraser,
  FileText,
  Mic,
  MicOff,
  X,
} from "lucide-react";

import {
  INITIAL_STATION_STATE,
  isStationState,
  type StationCommand,
  type StationState,
  type StationSuggestion,
} from "@/react-app/domains/station/station-types";
import "./station.css";

function isProcessing(phase: StationState["runtime"]["phase"]) {
  return phase === "speech_detected"
    || phase === "transcribing"
    || phase === "deciding"
    || phase === "tool_requested"
    || phase === "tool_running"
    || phase === "mcp_discovery_running"
    || phase === "connected_data_found";
}

function transcriptTail(value: string, limit = 320) {
  const clean = value.trim().replace(/\s+/g, " ");
  if (clean.length <= limit) return clean;
  const tail = clean.slice(-limit);
  const firstSpace = tail.indexOf(" ");
  return `…${firstSpace >= 0 ? tail.slice(firstSpace + 1) : tail}`;
}

function StationApp() {
  const [state, setState] = useState<StationState>(INITIAL_STATION_STATE);
  const [showDeveloperTranscript, setShowDeveloperTranscript] = useState(false);
  const autoApprovedGoalIdRef = useRef<string | null>(null);
  const selected = useMemo(
    () => state.suggestions.find((suggestion) => suggestion.id === state.selectedId)
      ?? state.suggestions[0]
      ?? null,
    [state.selectedId, state.suggestions],
  );
  const active = state.interactionMode === "active";
  const processing = isProcessing(state.runtime.phase);
  const goal = state.goal ?? null;
  const cardVisible = active && selected !== null && goal === null;
  const developerTranscriptAvailable = import.meta.env.DEV;
  const transcriptExpanded = showDeveloperTranscript;
  const captionVisible = developerTranscriptAvailable
    && transcriptExpanded
    && !cardVisible;
  const completedCaption = transcriptTail(state.transcript);
  const partialCaption = transcriptTail(state.partialTranscript, 180);
  const [presented, setPresented] = useState<StationSuggestion | null>(null);
  const presentedIndex = presented
    ? Math.max(0, state.suggestions.findIndex((suggestion) => suggestion.id === presented.id))
    : -1;

  const sendCommand = useCallback((command: StationCommand) => {
    window.__OPENWORK_STATION__?.sendCommand?.(command);
  }, []);

  useEffect(() => {
    if (
      transcriptExpanded
      || !goal
      || goal.status !== "proposed"
      || autoApprovedGoalIdRef.current === goal.id
    ) {
      return;
    }
    autoApprovedGoalIdRef.current = goal.id;
    sendCommand({ type: "approve-goal", id: goal.id });
  }, [goal, sendCommand, transcriptExpanded]);

  useEffect(() => {
    const bridge = window.__OPENWORK_STATION__;
    if (!bridge) return undefined;
    void bridge.setExpanded?.(false);
    void bridge.getState?.().then((value) => {
      if (isStationState(value)) setState(value);
    });
    return bridge.onState?.((value) => {
      if (isStationState(value)) setState(value);
    });
  }, []);

  useEffect(() => {
    void window.__OPENWORK_STATION__?.setExpanded?.(
      cardVisible || (developerTranscriptAvailable && transcriptExpanded),
    );
  }, [cardVisible, developerTranscriptAvailable, transcriptExpanded]);

  useEffect(() => {
    if (cardVisible && selected) {
      setPresented(selected);
      return undefined;
    }
    const timer = window.setTimeout(() => setPresented(null), 155);
    return () => window.clearTimeout(timer);
  }, [cardVisible, selected]);

  return (
    <main
      className={`station-stage ${active ? "is-active" : "is-passive"} ${
        cardVisible ? "has-card" : ""
      }`}
      aria-label="OpenWork Station passive AI"
      data-processing={processing ? "true" : "false"}
      data-runtime-phase={state.runtime.phase}
    >
      {captionVisible ? (
        <section
          className="station-caption"
          aria-label="Development live transcript"
          aria-live="polite"
          data-partial={partialCaption ? "true" : "false"}
        >
          <header>
            <span className="station-caption-live-dot" aria-hidden="true" />
            <strong>Live transcript</strong>
            <span>{state.provenance.model ?? "OpenAI Realtime"}</span>
            <div>
              <button
                type="button"
                aria-label={`${state.transcriptRecordEnabled ? "Disable" : "Enable"} transcript attachment for Station-started tasks`}
                aria-pressed={state.transcriptRecordEnabled}
                title={`${state.transcriptRecordEnabled ? "Attached" : "Not attached"} when starting a task`}
                className={state.transcriptRecordEnabled ? "is-on" : ""}
                onClick={() => sendCommand({
                  type: "set-transcript-record",
                  enabled: !state.transcriptRecordEnabled,
                })}
              >
                <FileText size={10} />
              </button>
              <button
                type="button"
                aria-label="Clear captured transcript"
                title="Clear transcript"
                disabled={!completedCaption && !partialCaption}
                onClick={() => sendCommand({ type: "clear-transcript" })}
              >
                <Eraser size={10} />
              </button>
              <button
                type="button"
                aria-label="Hide live transcript"
                title="Hide transcript"
                onClick={() => setShowDeveloperTranscript(false)}
              >
                <X size={10} />
              </button>
            </div>
          </header>
          <p>
            {completedCaption ? <span>{completedCaption}</span> : null}
            {partialCaption ? <mark>{partialCaption}</mark> : null}
            {!completedCaption && !partialCaption
              ? <em>Listening for clear speech…</em>
              : null}
          </p>
          {goal ? (
            <aside className="station-goal" data-status={goal.status} aria-label="Station intentional goal">
              <div>
                <span>{goal.status === "researching" ? "Working" : "I’ll"}</span>
                <strong>{goal.title}</strong>
              </div>
              <p>{goal.summary}</p>
              {goal.status === "proposed" ? (
                <footer>
                  <button
                    type="button"
                    onClick={() => sendCommand({ type: "dismiss-goal", id: goal.id })}
                  >
                    No
                  </button>
                  <button
                    type="button"
                    className="is-primary"
                    onClick={() => sendCommand({ type: "approve-goal", id: goal.id })}
                  >
                    Yes
                  </button>
                </footer>
              ) : (
                <span className="station-goal-progress">Researching while listening…</span>
              )}
            </aside>
          ) : null}
          <footer>
            <span>{state.runtime.phase.replaceAll("_", " ")}</span>
            <span>
              {state.provenance.inputSource ?? "awaiting microphone"}
              {" · "}
              {state.source === "openwork-connect"
                ? "connect"
                : state.source === "local-signal"
                  ? "connect unavailable"
                  : "connect waiting"}
            </span>
          </footer>
        </section>
      ) : null}

      {presented ? (
        <section
          className={`station-island ${cardVisible ? "is-visible" : ""}`}
          aria-live="polite"
          aria-hidden={!cardVisible}
          data-card-id={presented.id}
        >
          <article
            key={presented.id}
            className="station-card"
            data-station-kind={presented.kind}
            style={{ "--station-color": presented.color } as React.CSSProperties}
          >
            <header className="station-card-meta">
              <span className="station-priority-dot" />
              <span>Priority context</span>
            </header>

            <h1>{presented.title}</h1>
            <p>{presented.summary}</p>

            {presented.sources.length ? (
              <div className="station-evidence" aria-label="Connected evidence">
                <span>{presented.sources[0]?.provider}</span>
                <p>{presented.sources[0]?.label}</p>
              </div>
            ) : (
              <div className="station-evidence is-local">Live conversation</div>
            )}

            {state.error ? <div className="station-error">{state.error}</div> : null}

            <footer className="station-card-footer">
              <div className="station-history">
                <kbd aria-label="Older card"><ArrowLeft size={11} /></kbd>
                <span>{presentedIndex + 1} / {state.suggestions.length}</span>
                <kbd aria-label="Newer card"><ArrowRight size={11} /></kbd>
              </div>
              <div className="station-decisions">
                <button
                  type="button"
                  className="station-not-now"
                  onClick={() => sendCommand({ type: "dismiss", id: presented.id })}
                >
                  <span>Not now</span>
                </button>
                <button
                  type="button"
                  className="station-enter"
                  onClick={() => sendCommand({ type: "handoff", id: presented.id })}
                >
                  <span>Start thread</span>
                  <CornerDownLeft size={13} />
                </button>
              </div>
            </footer>
          </article>
        </section>
      ) : null}

      <aside
        className={`station-pill ${state.listening ? "is-listening" : ""}`}
        aria-label={`OpenWork Station ${state.interactionMode}: ${state.statusText}`}
        data-runtime-phase={state.runtime.phase}
        data-context-kind={selected?.kind ?? "ambient"}
        style={{ "--context-color": selected?.color ?? "#777981" } as React.CSSProperties}
      >
        <button
          type="button"
          className="station-mic"
          aria-label={state.listening ? "Stop OpenWork Station" : "Start OpenWork Station"}
          onClick={() => sendCommand({ type: state.listening ? "stop" : "start" })}
        >
          {state.listening ? <Mic size={14} /> : <MicOff size={14} />}
          <span />
        </button>

        <button
          type="button"
          className="station-mode-toggle"
          aria-label={`${state.statusText}. Switch Station to ${active ? "passive" : "active"} mode`}
          title={`${active ? "Active" : "Passive"} · ⌘⇧Space`}
          onClick={() => sendCommand({ type: "set-mode", active: !active })}
        >
          <span className="station-activity-dots" aria-hidden="true">
            {[0, 1, 2, 3, 4, 5, 6].map((dot) => <i key={dot} />)}
          </span>
        </button>
      </aside>

      {developerTranscriptAvailable ? (
        <button
          type="button"
          className={`station-caption-toggle ${transcriptExpanded ? "is-on" : ""}`}
          aria-label={`${transcriptExpanded ? "Hide" : "Show"} live development transcript`}
          title={`${transcriptExpanded ? "Hide" : "Show"} live transcript`}
          onClick={() => {
            if (transcriptExpanded) {
              setShowDeveloperTranscript(false);
              return;
            }
            setShowDeveloperTranscript(true);
          }}
        >
          <Captions size={12} strokeWidth={1.6} />
        </button>
      ) : null}
    </main>
  );
}

const root = document.getElementById("station-root");
if (!root) throw new Error("Missing OpenWork Station root");
createRoot(root).render(
  <StrictMode>
    <StationApp />
  </StrictMode>,
);
