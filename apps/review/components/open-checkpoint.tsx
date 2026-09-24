"use client";

import { useEffect, useRef, useState } from "react";
import type { ReviewEvidence } from "@openwork/review";

type ImageEvidence = Extract<ReviewEvidence, { kind: "image" }>;
export function OpenCheckpoint({ id, image, connected }: { id: string; image: ImageEvidence; connected: boolean }) {
  const checkpoint = image.checkpoint;
  const requestId = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const [forkExpired, setForkExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fork, setFork] = useState<{ url: string; expiresAt: string } | null>(null);
  useEffect(() => {
    if (!checkpoint) return;
    const update = () => {
      setExpired(Date.now() >= Date.parse(checkpoint.expiresAt));
      setForkExpired(Boolean(fork && Date.now() >= Date.parse(fork.expiresAt)));
    };
    update();
    const timer = setInterval(update, 30_000);
    return () => clearInterval(timer);
  }, [checkpoint, fork]);
  if (!checkpoint && !image.checkpointError) return null;
  async function launch() {
    if (busy) return;
    if (forkExpired) { requestId.current = null; setFork(null); }
    requestId.current ??= crypto.randomUUID();
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/r/${id}/checkpoint/${image.id}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: requestId.current }),
      });
      if (response.status === 410) { setExpired(true); return; }
      if (response.status === 429) { setError("Three copies are already open. Try again after one expires."); return; }
      if (!response.ok) throw new Error("Launch failed");
      const value: unknown = await response.json();
      if (typeof value !== "object" || value === null || !("url" in value) || typeof value.url !== "string"
        || !("expiresAt" in value) || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))
        || Date.parse(value.expiresAt) <= Date.now()) throw new Error("Invalid launch");
      const url = new URL(value.url);
      if (url.protocol !== "https:" || !/^evidence-[a-f0-9]{32}\.preview\.openwork\.software$/.test(url.hostname)
        || url.pathname !== "/__openwork_launch" || url.username || url.password) throw new Error("Invalid viewer");
      setFork({ url: value.url, expiresAt: value.expiresAt });
    } catch { setError("The checkpoint could not open. Try again."); }
    finally { setBusy(false); }
  }
  const available = checkpoint && !expired && connected;
  return <section aria-label="Interactive checkpoint" className="preview-launch">
    <div className="preview-launch-actions">
      {fork && !forkExpired ? <a className="preview-open" href={fork.url} target="_blank" rel="noreferrer">Enter saved browser</a>
        : <button type="button" onClick={launch} disabled={!available || busy} aria-busy={busy}>Open from here</button>}
    </div>
    <p role={error ? "alert" : "status"} className={error ? "preview-error" : "preview-state"}>
      {error ?? (fork && !forkExpired ? `Independent copy available until ${new Date(fork.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`
        : image.checkpointError ? "Checkpoint capture failed. Screenshot only."
        : expired ? "Checkpoint expired. Screenshot only."
        : !connected ? "Checkpoint access is not configured. Contact the review app owner."
        : busy ? "Opening an independent copy…" : "Saved browser available. Opens a private copy for one hour.")}
    </p>
  </section>;
}
