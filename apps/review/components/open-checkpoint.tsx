"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ReviewEvidence } from "@openwork/review";

type ImageEvidence = Extract<ReviewEvidence, { kind: "image" }>;
interface LaunchState {
  busy: boolean;
  unavailable?: boolean;
  error?: string;
  fork?: { url: string; expiresAt: string };
}
interface Launches {
  now: number | null;
  states: Record<string, LaunchState>;
  launch(reportId: string, imageId: string, newCopy?: boolean): Promise<void>;
}
const Context = createContext<Launches | null>(null);
const empty: LaunchState = { busy: false };

/** Cards and the image viewer share a copy and a retry key, not two allocations. */
export function CheckpointProvider({ children }: { children: ReactNode }) {
  const [states, setStates] = useState<Record<string, LaunchState>>({});
  const [now, setNow] = useState<number | null>(null);
  const active = useRef(new Set<string>());
  const pending = useRef(new Map<string, string>());
  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    const timer = setInterval(update, 30_000);
    document.addEventListener("visibilitychange", update);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, []);

  async function launch(reportId: string, imageId: string, newCopy = false) {
    const key = `${reportId}/${imageId}`;
    if (active.current.has(key)) return;
    active.current.add(key);
    if (newCopy) pending.current.delete(key);
    // Keep the nonce after an uncertain failure. A successful explicit new-copy
    // action gets a new nonce; retrying a lost response cannot spend another slot.
    const requestId = pending.current.get(key) ?? crypto.randomUUID();
    pending.current.set(key, requestId);
    const update = (patch: Partial<LaunchState>) => setStates((before) => ({ ...before, [key]: { ...empty, ...before[key], ...patch } }));
    update({ busy: true, error: undefined });
    try {
      const response = await fetch(`/r/${encodeURIComponent(reportId)}/checkpoint/${encodeURIComponent(imageId)}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId }),
      });
      if (response.status === 410) { update({ unavailable: true }); return; }
      if (response.status === 429) { update({ error: "Three copies are already open. Try again after one expires." }); return; }
      if (!response.ok) throw new Error("Launch failed");
      const value: unknown = await response.json();
      if (typeof value !== "object" || value === null || !("url" in value) || typeof value.url !== "string"
        || !("expiresAt" in value) || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))
        || Date.parse(value.expiresAt) <= Date.now()) throw new Error("Invalid launch");
      const url = new URL(value.url);
      if (url.protocol !== "https:" || !/^evidence-[a-f0-9]{32}\.preview\.openwork\.software$/.test(url.hostname)
        || url.pathname !== "/__openwork_launch" || url.username || url.password) throw new Error("Invalid viewer");
      pending.current.delete(key);
      update({ fork: { url: value.url, expiresAt: value.expiresAt }, unavailable: false });
    } catch { update({ error: "The checkpoint could not open. Try again." }); }
    finally { active.current.delete(key); update({ busy: false }); setNow(Date.now()); }
  }
  return <Context.Provider value={{ states, now, launch }}>{children}</Context.Provider>;
}

export function OpenCheckpoint({ id, image, connected, placement = "viewer" }: {
  id: string; image: ImageEvidence; connected: boolean; placement?: "card" | "viewer";
}) {
  const launches = useContext(Context);
  if (!launches) throw new Error("Checkpoint controls must belong to a report");
  const checkpoint = image.checkpoint;
  const state = launches.states[`${id}/${image.id}`] ?? empty;
  const expired = Boolean(checkpoint && launches.now !== null && launches.now >= Date.parse(checkpoint.expiresAt));
  const copyReady = state.fork && launches.now !== null && launches.now < Date.parse(state.fork.expiresAt);
  const available = Boolean(checkpoint && launches.now !== null && !expired && !state.unavailable && connected);
  const className = `preview-launch${placement === "card" ? " checkpoint-card" : ""}`;
  if (!checkpoint) return <p className={`preview-state${placement === "card" ? " checkpoint-card" : ""}`}>
    {image.checkpointError ? "Checkpoint capture failed. Screenshot only." : "Screenshot only — no saved browser."}
  </p>;
  return <section aria-label="Interactive checkpoint" className={className}>
    <div className="preview-launch-actions">
      {copyReady && state.fork
        ? <><a className="preview-open" href={state.fork.url} target="_blank" rel="noreferrer">Enter saved browser</a>
          <button type="button" className="quiet" onClick={() => launches.launch(id, image.id, true)} disabled={!available || state.busy} aria-busy={state.busy}>New copy</button></>
        : <><button type="button" onClick={() => launches.launch(id, image.id)} disabled={!available || state.busy} aria-busy={state.busy}>Open from here</button>
          {state.error && available && <button type="button" className="quiet" disabled={state.busy} onClick={() => launches.launch(id, image.id, true)}>New copy</button>}</>}
    </div>
    <p role={state.error ? "alert" : "status"} className={state.error ? "preview-error" : "preview-state"}>
      {state.error ?? (copyReady && state.fork ? `Independent copy available until ${new Date(state.fork.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`
        : state.unavailable ? "Checkpoint no longer available. Screenshot only."
        : expired ? "Checkpoint expired. Screenshot only."
        : !connected ? "Checkpoint access is not configured. Contact the review app owner."
        : state.busy ? "Opening an independent copy…"
        : state.fork ? "Previous copy expired. Open from here to restore this checkpoint again."
        : image.checkpointMatch === "approximate" ? "Saved browser available, captured while the screen was still changing. Opens a private copy for one hour."
        : "Saved browser available. Opens a private copy for one hour.")}
    </p>
  </section>;
}
