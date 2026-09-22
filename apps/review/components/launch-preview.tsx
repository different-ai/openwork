"use client";

import { useState } from "react";

interface Session { url: string; expiresAt: string }

export function LaunchPreview({ id, connected }: { id: string; connected: boolean }) {
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function launch() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/r/${id}/launch`, { method: "POST" });
      if (!response.ok) throw new Error("The sandbox could not launch. Try again.");
      const data: unknown = await response.json();
      if (typeof data !== "object" || data === null || !("url" in data) || typeof data.url !== "string"
        || !("expiresAt" in data) || typeof data.expiresAt !== "string") throw new Error("The launch could not be verified. Try again.");
      const url = new URL(data.url);
      if (url.protocol !== "https:" || !/^ow-[a-f0-9]{32}\.style\.dev$/.test(url.hostname)) throw new Error("The launch could not be verified. Try again.");
      setSession({ url: data.url, expiresAt: data.expiresAt });
    } catch (failure) {
      setError(failure instanceof TypeError
        ? "The reviewer could not be reached. Reload this page and try again."
        : "The sandbox could not launch. Try again.");
    } finally { setBusy(false); }
  }

  return (
    <div className="preview-launch">
      <div className="preview-launch-row">
        <span>{session ? "Your sandbox" : "Interactive preview"}</span>
        <div className="preview-launch-actions">
          {session && <a className="preview-open" href={session.url} target="_blank" rel="noreferrer">Open sandbox</a>}
          {/* Review has no shared button primitive; a native button retains keyboard/focus semantics. */}
          <button type="button" onClick={launch} disabled={!connected || busy} aria-busy={busy}
            aria-describedby="preview-state">Launch in Freestyle</button>
        </div>
      </div>
      <p id="preview-state" className={error ? "preview-error" : "preview-state"} role={error ? "alert" : "status"}>
        {!connected ? "Freestyle is not connected. The review app owner can connect it."
          : error ?? (session ? `Private sandbox · Expires ${new Date(session.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
            : "Fresh sandbox per launch · 2-hour lifetime")}
      </p>
      <details className="preview-details">
        <summary>Sandbox details</summary>
        <p>This preview runs the OpenWork web app and its local engine. Each launch restores this commit’s snapshot into a separate sandbox. The first launch for a commit can take several minutes. Sandboxes are deleted after two hours; work is not saved.</p>
      </details>
      {session && <details className="preview-details">
        <summary>Reveal sandbox link</summary>
        <p>Anyone with this link can access your sandbox until it expires.</p>
        <code style={{ overflowWrap: "anywhere", userSelect: "all" }}>{session.url}</code>
      </details>}
    </div>
  );
}
