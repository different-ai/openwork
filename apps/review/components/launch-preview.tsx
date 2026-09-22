"use client";

import { useState } from "react";
import { parsePreviewOutputs, type PreviewOutputs } from "@openwork/freestyle/outputs";

interface Session { url: string; expiresAt: string; outputs: PreviewOutputs }

export function LaunchPreview({ id, connected }: { id: string; connected: boolean }) {
  const [world, setWorld] = useState("app-web");
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function launch() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/r/${id}/launch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ world }) });
      if (!response.ok) throw new Error("The sandbox could not launch. Try again.");
      const data: unknown = await response.json();
      if (typeof data !== "object" || data === null || !("url" in data) || typeof data.url !== "string"
        || !("expiresAt" in data) || typeof data.expiresAt !== "string") throw new Error("The launch could not be verified. Try again.");
      const url = new URL(data.url);
      if (url.protocol !== "https:" || !/^ow-[a-f0-9]{32}\.(?:style\.dev|preview\.openwork\.software)$/.test(url.hostname)) throw new Error("The launch could not be verified. Try again.");
      setSession({ url: data.url, expiresAt: data.expiresAt, outputs: parsePreviewOutputs("outputs" in data ? data.outputs : {}) });
      setReveal(false); setCopied(false);
    } catch (failure) {
      setError(failure instanceof TypeError
        ? "The reviewer could not be reached. Reload this page and try again."
        : "The sandbox could not launch. Try again.");
    } finally { setBusy(false); }
  }

  return (
    <div className="preview-launch">
      <div className="preview-launch-row">
        <label>World <select aria-label="Preview world" value={world} disabled={busy} onChange={(event) => setWorld(event.target.value)}>
          <option value="app-web">OpenWork web</option>
          <option value="acme-web">ACME web · Full stack</option>
        </select></label>
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
        <p>OpenWork web runs the OpenWork web app and its local engine. ACME web adds isolated Den, MySQL, Redis, and AI Gateway services with demo accounts and a simulated model upstream. Each launch restores this commit’s snapshot into a separate sandbox. The first launch for a commit can take several minutes. Sandboxes are deleted after two hours; work is not saved.</p>
      </details>
      {session && Object.keys(session.outputs).length > 0 && <section className="preview-outputs" aria-label="World outputs">
        <div className="preview-launch-row">
          <strong>World outputs</strong>
          <div className="preview-launch-actions">
            <button type="button" aria-expanded={reveal} onClick={() => { setReveal(!reveal); setCopied(false); }}>{reveal ? "Hide credentials" : "Reveal outputs"}</button>
            <button type="button" onClick={async () => {
              const values = Object.fromEntries(Object.entries(session.outputs).map(([key, entry]) => [key, entry.secret && !reveal ? "••••••••" : entry.value]));
              try { await navigator.clipboard.writeText(JSON.stringify(values, null, 2)); setCopied(true); }
              catch { setError("Could not copy. Select the revealed values to copy them manually."); }
            }}>{copied ? "Copied" : "Copy outputs"}</button>
          </div>
        </div>
        <table><thead><tr><th>Group</th><th>Output</th><th>Value</th></tr></thead><tbody>
          {Object.entries(session.outputs).map(([key, entry]) => <tr key={key}>
            <td>{entry.group}</td><th scope="row">{key}</th><td>
              <code>{entry.secret && !reveal ? "••••••••" : entry.value}</code>
              {entry.group === "Services" && <a href={entry.value} target="_blank" rel="noreferrer">Open service</a>}
              {entry.note && <small>{entry.note}</small>}
            </td>
          </tr>)}
        </tbody></table>
      </section>}
      {session && <details className="preview-details">
        <summary>Reveal sandbox link</summary>
        <p>Anyone with this link can access your sandbox until it expires.</p>
        <code style={{ overflowWrap: "anywhere", userSelect: "all" }}>{session.url}</code>
      </details>}
    </div>
  );
}
