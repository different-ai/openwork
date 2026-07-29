/** @jsxImportSource react */
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  CalendarClock,
  Check,
  Mail,
  MessageSquareText,
  Mic,
  MicOff,
  Sparkles,
} from "lucide-react";

import {
  INITIAL_STATION_STATE,
  isStationState,
  type StationCommand,
  type StationState,
  type StationSuggestion,
} from "@/react-app/domains/station/station-types";
import { contextualBubbleDiameter } from "./station-visual-model";
import "./station.css";

function suggestionIcon(kind: StationSuggestion["kind"]) {
  if (kind === "memory") return MessageSquareText;
  if (kind === "calendar") return CalendarClock;
  if (kind === "follow_up") return Mail;
  return Sparkles;
}

function relevanceLabel(value: number) {
  if (value >= 0.88) return "High signal";
  if (value >= 0.64) return "Relevant now";
  return "In context";
}

const CLUSTER_LAYOUT = [
  { x: -7, rotation: -7 },
  { x: 7, rotation: 5 },
  { x: -5, rotation: -4 },
  { x: 8, rotation: 8 },
  { x: -8, rotation: -8 },
  { x: 7, rotation: 4 },
  { x: -6, rotation: -5 },
  { x: 6, rotation: 6 },
] as const;

const STATION_CARD_REVEAL_DELAY_MS = 320;
const STATION_RETRACT_DELAY_MS = 150;
const STATION_COLLAPSE_DELAY_MS = 210;

type CardMode = "hidden" | "peek" | "pinned";

type ClusterParticle = {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
};

function useOrganicCluster(
  suggestions: StationSuggestion[],
  selectedId: string | null,
  hoveredId: string | null,
  audioEnergy: number,
  contextKind: StationSuggestion["kind"] | "ambient",
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bubbleNodesRef = useRef(new Map<string, HTMLButtonElement>());
  const particlesRef = useRef(new Map<string, ClusterParticle>());
  const dynamicsRef = useRef({ suggestions, selectedId, hoveredId, audioEnergy, contextKind });
  dynamicsRef.current = { suggestions, selectedId, hoveredId, audioEnergy, contextKind };

  const registerBubble = useCallback((id: string, node: HTMLButtonElement | null) => {
    if (node) bubbleNodesRef.current.set(id, node);
    else bubbleNodesRef.current.delete(id);
  }, []);

  useEffect(() => {
    let frame = 0;
    let previous = performance.now();
    const simulate = (now: number) => {
      const container = containerRef.current;
      const config = dynamicsRef.current;
      if (!container) {
        frame = window.requestAnimationFrame(simulate);
        return;
      }
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width < 8 || height < 8) {
        frame = window.requestAnimationFrame(simulate);
        return;
      }
      const dt = Math.min(2, Math.max(.35, (now - previous) / 16.667));
      previous = now;
      const centerX = width / 2;
      const centerY = height / 2;
      const activeIds = new Set(config.suggestions.map((suggestion) => suggestion.id));
      for (const id of particlesRef.current.keys()) {
        if (!activeIds.has(id)) particlesRef.current.delete(id);
      }
      const particles = config.suggestions.map((suggestion, index) => {
        let particle = particlesRef.current.get(suggestion.id);
        if (!particle) {
          const progress = config.suggestions.length <= 1 ? .5 : index / (config.suggestions.length - 1);
          const clusterSpan = Math.min(height * .72, Math.max(0, (config.suggestions.length - 1) * 30));
          const layout = CLUSTER_LAYOUT[index % CLUSTER_LAYOUT.length]!;
          particle = {
            id: suggestion.id,
            x: centerX + layout.x,
            y: centerY + (progress - .5) * clusterSpan,
            vx: (index % 2 ? 1 : -1) * .08,
            vy: 0,
          };
          particlesRef.current.set(suggestion.id, particle);
        }
        return { particle, suggestion, index };
      });

      const interactionPaused = config.hoveredId !== null;
      for (const { particle, suggestion, index } of particles) {
        if (interactionPaused) {
          particle.vx = 0;
          particle.vy = 0;
          continue;
        }
        const progress = particles.length <= 1 ? .5 : index / (particles.length - 1);
        const clusterSpan = Math.min(height * .72, Math.max(0, (particles.length - 1) * 30));
        const layout = CLUSTER_LAYOUT[index % CLUSTER_LAYOUT.length]!;
        const targetX = centerX + layout.x;
        const targetY = centerY + (progress - .5) * clusterSpan;
        particle.vx += (targetX - particle.x) * .0018 * dt;
        particle.vy += (targetY - particle.y) * .00145 * dt;
        const dx = particle.x - centerX;
        const dy = particle.y - centerY;
        if (config.contextKind === "memory") {
          particle.vx += -dy * .000055 * dt;
          particle.vy += dx * .000055 * dt;
        } else if (config.contextKind === "calendar") {
          particle.vy += Math.sin(now / 420 + index * 1.4) * .006 * dt;
        } else if (config.contextKind === "follow_up") {
          particle.vx -= (.006 + config.audioEnergy * .015) * dt;
        } else {
          particle.vx += Math.sin(now / 760 + index) * .003 * dt;
          particle.vy += Math.cos(now / 880 + index) * .003 * dt;
        }
        const distance = Math.max(1, Math.hypot(dx, dy));
        const speechPush = config.audioEnergy * (.018 + suggestion.effectiveRelevance * .012);
        particle.vx += (dx / distance) * speechPush * dt;
        particle.vy += (dy / distance) * speechPush * dt;
      }

      for (let leftIndex = 0; !interactionPaused && leftIndex < particles.length; leftIndex += 1) {
        const left = particles[leftIndex]!;
        const leftRadius = contextualBubbleDiameter(left.suggestion) / 2;
        for (let rightIndex = leftIndex + 1; rightIndex < particles.length; rightIndex += 1) {
          const right = particles[rightIndex]!;
          const rightRadius = contextualBubbleDiameter(right.suggestion) / 2;
          const dx = right.particle.x - left.particle.x;
          const dy = right.particle.y - left.particle.y;
          const distance = Math.max(.01, Math.hypot(dx, dy));
          const minimum = (leftRadius + rightRadius) * .82;
          if (distance >= minimum) continue;
          const overlap = (minimum - distance) * .5;
          const nx = dx / distance;
          const ny = dy / distance;
          left.particle.x -= nx * overlap;
          left.particle.y -= ny * overlap;
          right.particle.x += nx * overlap;
          right.particle.y += ny * overlap;
          const impulse = overlap * .012;
          left.particle.vx -= nx * impulse;
          left.particle.vy -= ny * impulse;
          right.particle.vx += nx * impulse;
          right.particle.vy += ny * impulse;
        }
      }

      for (const { particle, suggestion, index } of particles) {
        const radius = contextualBubbleDiameter(suggestion) / 2;
        if (!interactionPaused) {
          particle.vx *= Math.pow(.93, dt);
          particle.vy *= Math.pow(.93, dt);
          particle.x += particle.vx * dt;
          particle.y += particle.vy * dt;
        }
        const minX = radius * .72;
        const maxX = width - radius * .72;
        const minY = radius * .72;
        const maxY = height - radius * .72;
        if (particle.x < minX || particle.x > maxX) {
          particle.x = Math.min(maxX, Math.max(minX, particle.x));
          particle.vx *= -.42;
        }
        if (particle.y < minY || particle.y > maxY) {
          particle.y = Math.min(maxY, Math.max(minY, particle.y));
          particle.vy *= -.42;
        }
        const node = bubbleNodesRef.current.get(particle.id);
        if (!node) continue;
        const active = particle.id === config.selectedId;
        const rotation = CLUSTER_LAYOUT[index % CLUSTER_LAYOUT.length]!.rotation;
        const breath = 1 + Math.sin(now / (1_400 + index * 90) + index * 1.7)
          * (.018 + suggestion.effectiveRelevance * .026 + config.audioEnergy * .035);
        node.style.left = `${particle.x.toFixed(2)}px`;
        node.style.top = `${particle.y.toFixed(2)}px`;
        node.style.transform = `translate(-50%, -50%) rotate(${active ? 0 : rotation}deg) scale(${
          ((active ? 1.035 : 1) * breath).toFixed(4)
        })`;
      }
      frame = window.requestAnimationFrame(simulate);
    };
    frame = window.requestAnimationFrame(simulate);
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return { containerRef, registerBubble };
}

function playTactileTick(direction: number) {
  try {
    navigator.vibrate?.(direction > 0 ? 7 : 11);
    const AudioContextClass = window.AudioContext
      ?? Reflect.get(window, "webkitAudioContext") as typeof AudioContext | undefined;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = direction > 0 ? 520 : 440;
    gain.gain.setValueAtTime(0.018, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.055);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.06);
    oscillator.addEventListener("ended", () => void context.close(), { once: true });
  } catch {
    // Sound is a tactile enhancement; browser autoplay policy may decline it.
  }
}

function StationApp() {
  const [state, setState] = useState<StationState>(INITIAL_STATION_STATE);
  const [expanded, setExpandedState] = useState(false);
  const [railHovered, setRailHovered] = useState(false);
  const [bubblesArmed, setBubblesArmed] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [cardMode, setCardMode] = useState<CardMode>("hidden");
  const [railImpulse, setRailImpulse] = useState<-1 | 0 | 1>(0);
  const collapseTimerRef = useRef<number | null>(null);
  const cardRevealTimerRef = useRef<number | null>(null);
  const railImpulseTimerRef = useRef<number | null>(null);
  const peekOriginRef = useRef<{ screenX: number; screenY: number } | null>(null);
  const railHoverOriginRef = useRef<{ screenX: number; screenY: number } | null>(null);
  const cardModeRef = useRef<CardMode>("hidden");
  const selected = useMemo(
    () => state.suggestions.find((suggestion) => suggestion.id === state.selectedId)
      ?? state.suggestions[0]
      ?? null,
    [state.selectedId, state.suggestions],
  );
  const cluster = useOrganicCluster(
    state.suggestions,
    selected?.id ?? null,
    hoveredId,
    state.audioEnergy,
    selected?.kind ?? "ambient",
  );

  const sendCommand = useCallback((command: StationCommand) => {
    window.__OPENWORK_STATION__?.sendCommand?.(command);
  }, []);

  const setExpanded = useCallback((value: boolean) => {
    if (collapseTimerRef.current !== null) {
      window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
    setExpandedState(value);
    void window.__OPENWORK_STATION__?.setExpanded?.(value);
  }, []);

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

  useEffect(() => () => {
    if (collapseTimerRef.current !== null) window.clearTimeout(collapseTimerRef.current);
    if (cardRevealTimerRef.current !== null) window.clearTimeout(cardRevealTimerRef.current);
    if (railImpulseTimerRef.current !== null) window.clearTimeout(railImpulseTimerRef.current);
  }, []);

  const retractCard = useCallback((collapseSurface = true) => {
    if (cardRevealTimerRef.current !== null) {
      window.clearTimeout(cardRevealTimerRef.current);
      cardRevealTimerRef.current = null;
    }
    peekOriginRef.current = null;
    cardModeRef.current = "hidden";
    setCardMode("hidden");
    if (!collapseSurface) return;
    if (collapseTimerRef.current !== null) window.clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = window.setTimeout(() => {
      setExpanded(false);
    }, STATION_COLLAPSE_DELAY_MS);
  }, [setExpanded]);

  const revealSuggestion = useCallback((id: string, screenX: number, screenY: number) => {
    if (cardRevealTimerRef.current !== null) window.clearTimeout(cardRevealTimerRef.current);
    cardRevealTimerRef.current = window.setTimeout(() => {
      cardRevealTimerRef.current = null;
      peekOriginRef.current = { screenX, screenY };
      playTactileTick(1);
      sendCommand({ type: "select", id });
      setExpanded(true);
      cardModeRef.current = "peek";
      setCardMode("peek");
    }, STATION_CARD_REVEAL_DELAY_MS);
  }, [sendCommand, setExpanded]);

  const cancelSuggestionReveal = useCallback(() => {
    if (cardRevealTimerRef.current === null) return;
    window.clearTimeout(cardRevealTimerRef.current);
    cardRevealTimerRef.current = null;
  }, []);

  const leaveSuggestion = useCallback(() => {
    setHoveredId(null);
    cancelSuggestionReveal();
    if (cardModeRef.current === "peek") retractCard(false);
  }, [cancelSuggestionReveal, retractCard]);

  const moveSelection = useCallback((direction: number) => {
    if (state.suggestions.length < 2) return;
    const selectedIndex = Math.max(0, state.suggestions.findIndex((suggestion) => suggestion.id === selected?.id));
    const nextIndex = (selectedIndex + direction + state.suggestions.length) % state.suggestions.length;
    const next = state.suggestions[nextIndex];
    if (!next) return;
    playTactileTick(direction);
    if (railImpulseTimerRef.current !== null) window.clearTimeout(railImpulseTimerRef.current);
    setRailImpulse(direction > 0 ? 1 : -1);
    railImpulseTimerRef.current = window.setTimeout(() => setRailImpulse(0), 150);
    sendCommand({ type: "select", id: next.id });
  }, [selected?.id, sendCommand, state.suggestions]);

  const handleWheel = useCallback((event: React.WheelEvent) => {
    event.preventDefault();
    if (Math.abs(event.deltaY) < 2) return;
    moveSelection(event.deltaY > 0 ? 1 : -1);
  }, [moveSelection]);

  const scheduleCollapse = useCallback(() => {
    setRailHovered(false);
    cancelSuggestionReveal();
    retractCard(true);
  }, [cancelSuggestionReveal, retractCard]);

  const expandRail = useCallback((event: React.MouseEvent) => {
    if (collapseTimerRef.current !== null) {
      window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
    railHoverOriginRef.current = { screenX: event.screenX, screenY: event.screenY };
    setBubblesArmed(false);
    setRailHovered(true);
  }, []);

  const leaveRail = useCallback(() => {
    setRailHovered(false);
    setBubblesArmed(false);
    setHoveredId(null);
    railHoverOriginRef.current = null;
    cancelSuggestionReveal();
    if (cardModeRef.current === "peek") {
      retractCard(true);
      return;
    }
    if (cardModeRef.current === "hidden") retractCard(true);
  }, [cancelSuggestionReveal, retractCard]);

  const handleRailMovement = useCallback((event: React.MouseEvent) => {
    if (bubblesArmed || !railHoverOriginRef.current) return;
    const distance = Math.hypot(
      event.screenX - railHoverOriginRef.current.screenX,
      event.screenY - railHoverOriginRef.current.screenY,
    );
    if (distance > 7) setBubblesArmed(true);
  }, [bubblesArmed]);

  const handleBubbleMovement = useCallback((event: React.MouseEvent) => {
    if (cardModeRef.current !== "peek" || !peekOriginRef.current) return;
    const distance = Math.hypot(
      event.screenX - peekOriginRef.current.screenX,
      event.screenY - peekOriginRef.current.screenY,
    );
    if (distance > 3) retractCard(false);
  }, [retractCard]);

  return (
    <main
      className={`station-stage ${expanded ? "is-expanded" : ""} ${railHovered ? "is-rail-hovered" : ""}`}
      onMouseLeave={scheduleCollapse}
      onWheel={handleWheel}
      aria-label="OpenWork Station passive AI"
      data-speaking={state.audioEnergy > 0.12 ? "true" : "false"}
      style={{
        "--speech-meter-low": 0.22 + state.audioEnergy * 0.78,
        "--speech-meter-mid": 0.3 + state.audioEnergy * 0.7,
        "--speech-meter-high": 0.18 + state.audioEnergy * 0.82,
        "--cluster-scale-small": 0.48 + state.audioEnergy * 0.04,
        "--cluster-scale-open": 0.96 + state.audioEnergy * 0.03,
      } as React.CSSProperties}
    >
      {expanded && selected ? (
        <section
          className={`station-island ${cardMode === "hidden" ? "" : "is-card-visible"} ${
            cardMode === "peek" ? "is-card-peek" : cardMode === "pinned" ? "is-card-pinned" : ""
          }`}
          aria-live="polite"
          aria-hidden={cardMode === "hidden"}
          data-card-id={selected.id}
          onMouseLeave={() => retractCard(true)}
        >
          <article
            key={selected.id}
            className="station-card"
            data-station-kind={selected.kind}
            style={{ "--station-color": selected.color } as React.CSSProperties}
          >
            <div className="station-card-meta">
              <span className="station-card-icon">
                {(() => {
                  const Icon = suggestionIcon(selected.kind);
                  return <Icon size={16} />;
                })()}
              </span>
              <span>{relevanceLabel(selected.effectiveRelevance)}</span>
              <span className="station-relevance">
                {Math.round(selected.effectiveRelevance * 100)}
              </span>
            </div>
            <h1>{selected.title}</h1>
            <p>{selected.summary}</p>
            <div className="station-why">
              <Sparkles size={13} />
              <span><b>Why now:</b> {selected.reason}</span>
            </div>
            {selected.sources.length ? (
              <div className="station-sources" aria-label="Connected sources">
                {selected.sources.map((source) => (
                  <button
                    type="button"
                    key={`${source.provider}:${source.url}`}
                    onClick={() => sendCommand({ type: "activate", id: selected.id })}
                  >
                    <span>{source.provider}</span>
                    {source.label}
                    <ArrowUpRight size={12} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="station-no-source">Local signal · no connected source claimed</div>
            )}
            {state.error ? <div className="station-error">{state.error}</div> : null}
            <div className="station-actions">
              <button
                type="button"
                className="station-primary"
                disabled={selected.action.kind === "none"}
                onClick={() => sendCommand({ type: "activate", id: selected.id })}
              >
                {selected.action.kind === "open_source" ? <ArrowUpRight size={14} /> : <Check size={14} />}
                {selected.action.label}
              </button>
              <button
                type="button"
                className="station-dismiss"
                onClick={() => sendCommand({ type: "dismiss", id: selected.id })}
              >
                Not now
              </button>
            </div>
            {selected.action.kind === "review_draft" ? (
              <div className="station-boundary">Prepared for review · never sent automatically</div>
            ) : null}
          </article>
        </section>
      ) : null}

      <aside
        className={`station-pill ${state.listening ? "is-listening" : ""} ${
          bubblesArmed ? "is-intent-armed" : ""
        } ${
          railImpulse > 0 ? "is-ticking-down" : railImpulse < 0 ? "is-ticking-up" : ""
        }`}
        aria-label={state.listening ? "OpenWork Station is listening" : "OpenWork Station is paused"}
        onMouseEnter={expandRail}
        onMouseLeave={leaveRail}
        onMouseMove={handleRailMovement}
        data-context-kind={selected?.kind ?? "ambient"}
        style={{ "--context-color": selected?.color ?? "#73757d" } as React.CSSProperties}
      >
        <button
          type="button"
          className="station-mic"
          aria-label={state.listening ? "Stop OpenWork Station" : "Start OpenWork Station"}
          onClick={(event) => {
            event.stopPropagation();
            sendCommand({ type: state.listening ? "stop" : "start" });
          }}
        >
          {state.listening ? <Mic size={15} /> : <MicOff size={15} />}
          <span />
        </button>
        <div className="station-sound-meter" aria-hidden="true">
          <span /><span /><span />
        </div>
        <div
          ref={cluster.containerRef}
          className="station-bubbles"
          aria-label={`${state.suggestions.length} passive AI suggestions`}
        >
          {state.suggestions.map((suggestion, index) => {
            const size = contextualBubbleDiameter(suggestion);
            const active = suggestion.id === selected?.id;
            const layout = CLUSTER_LAYOUT[index % CLUSTER_LAYOUT.length]!;
            const count = state.suggestions.length;
            const top = count <= 1 ? 50 : 13 + (index / (count - 1)) * 74;
            return (
              <button
                type="button"
                key={suggestion.id}
                ref={(node) => cluster.registerBubble(suggestion.id, node)}
                className={active ? "is-active" : ""}
                aria-label={`${suggestion.title}, ${Math.round(suggestion.effectiveRelevance * 100)} percent relevant`}
                style={{
                  "--bubble-color": suggestion.color,
                  "--bubble-size": `${size}px`,
                  "--cluster-x": `${layout.x}px`,
                  "--cluster-top": `${top}%`,
                  "--cluster-rotation": `${layout.rotation}deg`,
                  "--cluster-delay": `${index * -170}ms`,
                } as React.CSSProperties}
                onMouseEnter={(event) => {
                  setHoveredId(suggestion.id);
                  revealSuggestion(suggestion.id, event.screenX, event.screenY);
                }}
                onMouseLeave={leaveSuggestion}
                onMouseMove={handleBubbleMovement}
                onClick={() => {
                  cancelSuggestionReveal();
                  playTactileTick(index % 2 ? 1 : -1);
                  sendCommand({ type: "select", id: suggestion.id });
                  setExpanded(true);
                  cardModeRef.current = "pinned";
                  setCardMode("pinned");
                }}
                onFocus={() => {
                  setHoveredId(suggestion.id);
                  setRailHovered(true);
                  setBubblesArmed(true);
                  sendCommand({ type: "select", id: suggestion.id });
                  setExpanded(true);
                  cardModeRef.current = "pinned";
                  setCardMode("pinned");
                }}
              >
                <span />
              </button>
            );
          })}
          {!state.suggestions.length ? (
            <>
              <i /><i /><i />
            </>
          ) : null}
        </div>
        <span className="station-wordmark">STATION</span>
      </aside>
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
