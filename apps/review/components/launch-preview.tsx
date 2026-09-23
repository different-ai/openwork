"use client";

import { useState } from "react";
import { parsePreviewOutputs, type PreviewOutputs } from "@openwork/freestyle/outputs";

interface Session { url: string; expiresAt: string; outputs: PreviewOutputs; desktop: boolean }

export function LaunchPreview({ id, connected }: { id: string; connected: boolean }) {
  const [world, setWorld] = useState("app-web");
  const [reveal, setReveal] = useState(true);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function launch() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const requestedWorld = world === "acme-desktop" ? "acme-web" : world;
      const desktop = world === "desktop" || world === "acme-desktop";
      const response = await fetch(`/r/${id}/launch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ world: requestedWorld }) });
      if (!response.ok) throw new Error("The sandbox could not launch. Try again.");
      const data: unknown = await response.json();
      if (typeof data !== "object" || data === null || !("url" in data) || typeof data.url !== "string"
        || !("expiresAt" in data) || typeof data.expiresAt !== "string"
        || !("world" in data) || data.world !== requestedWorld) throw new Error("The launch could not be verified. Try again.");
      const url = new URL(data.url);
      const host = world === "desktop" ? /^desktop-[a-f0-9]{32}\.(?:style\.dev|preview\.openwork\.software)$/ : /^ow-[a-f0-9]{32}\.(?:style\.dev|preview\.openwork\.software)$/;
      if (url.protocol !== "https:" || !host.test(url.hostname)) throw new Error("The launch could not be verified. Try again.");
      const outputs = parsePreviewOutputs("outputs" in data ? data.outputs : {});
      if (desktop && !outputs.desktopUrl) throw new Error("The desktop could not launch. Try again.");
      setSession({ url: desktop ? outputs.desktopUrl.value : data.url, expiresAt: data.expiresAt, outputs, desktop });
      setReveal(true); setCopied(false);
    } catch (failure) {
      setError(failure instanceof TypeError
        ? "The reviewer could not be reached. Reload this page and try again."
        : "The sandbox could not launch. Try again.");
    } finally { setBusy(false); }
  }

  const services: [string, { value: string }][] = session ? Object.entries(session.outputs).filter(([, entry]) => entry.group === "Services") : [];
  if (session && !services.length) services.push(["webUrl", { value: session.url }]);
  const serviceNames: Record<string, string> = { webUrl: "OpenWork", denWeb: "Den dashboard", denApi: "Den API", openworkUrl: "OpenWork engine", gatewayUrl: "AI Gateway", desktopUrl: "Desktop app" };
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setCopied(true); }
    catch { setError("Could not copy. Select the visible value to copy it manually."); }
  }
  function field(key: string, label: string, value: string, secret = false) {
    return <div className="connection-field" key={key}>
      <div className="preview-launch-row"><strong>{label}</strong><button type="button" aria-label={`Copy ${label}`} onClick={() => copy(value)}>Copy</button></div>
      <code>{secret && !reveal ? "••••••••" : value}</code>
    </div>;
  }

  return (
    <div className="preview-launch">
      <h2>Your sandbox</h2>
      <p className="preview-state">Your own URLs, workspace, and data. Teammates get separate sandboxes.</p>
      <label>World <select aria-label="Preview world" value={world} disabled={busy} onChange={(event) => { setWorld(event.target.value); setSession(null); setError(null); setCopied(false); }}>
        <option value="app-web">OpenWork web</option>
        <option value="desktop">Desktop only (signed out)</option>
        <option value="acme-web">ACME web (full stack)</option>
        <option value="acme-desktop">ACME desktop (full stack)</option>
      </select></label>
      <div className="preview-launch-actions">
        {session && <a className="preview-open" href={session.url} target="_blank" rel="noreferrer">{session.desktop ? "Open desktop" : "Open sandbox"}</a>}
        <button type="button" onClick={launch} disabled={!connected || busy} aria-busy={busy} aria-describedby="preview-state">Launch in Freestyle</button>
      </div>
      <p id="preview-state" className={error ? "preview-error" : "preview-state"} role={error ? "alert" : "status"}>
        {!connected ? "Freestyle is not connected. The review app owner can connect it."
          : error ?? (busy ? "Your new sandbox is starting. This can take a few minutes."
            : session ? `Private sandbox · Expires ${new Date(session.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Fresh sandbox per launch · 2-hour lifetime")}
      </p>
      {session && <section aria-label="Your connection details">
        <div className="preview-launch-row">
          <button type="button" onClick={() => copy(JSON.stringify({ sandboxUrl: session.url, ...Object.fromEntries(Object.entries(session.outputs).map(([key, entry]) => [key, entry.value])) }, null, 2))}>Copy all connection details</button>
          <button type="button" onClick={() => setReveal(!reveal)}>{reveal ? "Hide credentials" : "Show credentials"}</button>
        </div>
        {copied && <p role="status">Copied to clipboard</p>}
        {session.outputs.alexEmail && <section className="connection-group" aria-label="Sign in">
          <h3>Sign in</h3>
          {field("email", "Email", session.outputs.alexEmail.value)}
          {session.outputs.alexPassword && field("password", "Password", session.outputs.alexPassword.value, true)}
        </section>}
        <section className="connection-group" aria-label="Your service URLs">
          <h3>Your service URLs</h3>
          {services.map(([key, entry]) => {
            const name = serviceNames[key] ?? key;
            return <div className="connection-field" key={key}>
              <div className="preview-launch-row"><a href={entry.value} target="_blank" rel="noreferrer">Open {name} ↗</a><button type="button" aria-label={`Copy ${name} URL`} onClick={() => copy(entry.value)}>Copy URL</button></div>
              <code>{reveal ? entry.value : new URL(entry.value).origin}</code>
            </div>;
          })}
        </section>
        <details className="preview-details"><summary>Developer credentials and connections</summary>
          {Object.entries(session.outputs).filter(([key, entry]) => entry.group !== "Services" && key !== "alexEmail" && key !== "alexPassword").map(([key, entry]) => <div key={key}>
            {field(key, key, entry.value, entry.secret)}
            {entry.note && <small>{entry.note}</small>}
          </div>)}
        </details>
      </section>}
      <details className="preview-details"><summary>Sandbox details</summary>
        <p>OpenWork web runs the OpenWork web app and its local engine. Desktop only opens the real desktop app from this commit with a fresh, signed-out profile: no Den, databases, AI Gateway, demo accounts, or separate web preview. Its local engine and internal renderer belong to the desktop app. ACME web and ACME desktop keep the full stack with demo accounts and a simulated model upstream. Each launch restores this commit’s snapshot into a separate sandbox. Sandboxes expire after two hours; work is not saved.</p>
      </details>
    </div>
  );
}
