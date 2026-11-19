"use client";

import { useEffect, useRef, useState } from "react";
import { CopyButton } from "./copy-button";
import { BuildReadiness, advance, startTracking, type BuildStepView, type BuildTracker } from "./build-readiness";
import { parsePreviewOutputs, type PreviewOutputs } from "@openwork/freestyle/outputs";
import { previewAccessUrl, type PreviewProviderOption } from "../lib/preview-options";

interface Session { url: string; expiresAt: string; outputs: PreviewOutputs; desktop: boolean; world: string; providerLabel: string }

// A first launch builds the commit's snapshot after the POST returns 202.
const BUILD_POLL_MS = 4_000;
const BUILD_GIVE_UP_MS = 15 * 60_000;
// No builder VM is alive while the source tree is read or between layers, so only
// a sustained absence after this grace period counts as a failed build.
const BUILD_FAILED_GRACE_MS = 2 * 60_000;
const BUILD_FAILED_IDLE_POLLS = 3;

const WORLD_NAMES: Record<string, string> = { "app-web": "OpenWork web", "acme-web": "ACME", desktop: "Desktop only" };

interface BuildPoll { ready: boolean; building: boolean; layer?: string; steps: BuildStepView[] }

function progressOf(body: object): Pick<BuildPoll, "layer" | "steps"> {
  const progress: unknown = "progress" in body ? body.progress : undefined;
  if (typeof progress !== "object" || progress === null) return { steps: [] };
  const layer = "layer" in progress && typeof progress.layer === "string" ? progress.layer : undefined;
  const raw: unknown = "steps" in progress ? progress.steps : [];
  const steps: BuildStepView[] = [];
  if (Array.isArray(raw)) for (const step of raw) {
    if (typeof step === "object" && step !== null && "id" in step && typeof step.id === "string" && "ms" in step && typeof step.ms === "number") steps.push({ id: step.id, ms: step.ms });
  }
  return { ...(layer ? { layer } : {}), steps };
}

async function buildState(id: string, world: string, provider?: string): Promise<BuildPoll> {
  const query = new URLSearchParams({ world, ...(provider ? { provider } : {}) });
  const response = await fetch(`/r/${id}/launch?${query}`, { cache: "no-store" });
  if (response.status === 503) throw new Error("launch-unavailable");
  if (!response.ok) throw new Error("launch-status-failed");
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("ready" in body) || typeof body.ready !== "boolean"
    || !("building" in body) || typeof body.building !== "boolean") throw new Error("launch-status-failed");
  return { ready: "ready" in body && body.ready === true, building: "building" in body && body.building === true, ...progressOf(body) };
}

export function LaunchPreview({ id, connected, providerLabel, providers }: { id: string; connected: boolean; providerLabel: string; providers?: readonly PreviewProviderOption[] }) {
  const [providerId, setProviderId] = useState(() => providers?.find((provider) => provider.connected)?.id ?? providers?.[0]?.id);
  const provider = providers?.find((option) => option.id === providerId);
  const label = provider?.label ?? providerLabel;
  const available = provider?.connected ?? connected;
  const [world, setWorld] = useState("app-web");
  const [reveal, setReveal] = useState(false);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [build, setBuild] = useState<{ tracker: BuildTracker; world: string } | null>(null);
  const mounted = useRef(true);

  // Set in the body too: React's development double-mount runs the cleanup once.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!session) return;
    const update = () => setExpired(Date.now() >= Date.parse(session.expiresAt));
    update();
    const timer = setTimeout(update, Math.min(2_147_483_647, Math.max(0, Date.parse(session.expiresAt) - Date.now())));
    document.addEventListener("visibilitychange", update);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", update); };
  }, [session]);

  async function launch() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setBuild(null);
    let buildOutcome: "still-building" | "failed" | null = null;
    try {
      const requestedWorld = world === "acme-desktop" ? "acme-web" : world;
      const desktop = world === "desktop" || world === "acme-desktop";
      const request = () => fetch(`/r/${id}/launch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ world: requestedWorld, ...(provider ? { provider: provider.id } : {}) }) });
      let response = await request();
      if (response.status === 202) {
        const started = Date.now();
        let tracker = startTracking(started);
        setBuild({ tracker, world: requestedWorld });
        let idlePolls = 0;
        while (true) {
          const state = await buildState(id, requestedWorld, provider?.id);
          if (!mounted.current) return;
          if (state.ready) break;
          tracker = advance(tracker, state, Date.now());
          setBuild({ tracker, world: requestedWorld });
          idlePolls = state.building ? 0 : idlePolls + 1;
          const failed = idlePolls >= BUILD_FAILED_IDLE_POLLS && Date.now() - started > BUILD_FAILED_GRACE_MS;
          if (failed || Date.now() - started > BUILD_GIVE_UP_MS) {
            buildOutcome = failed ? "failed" : "still-building";
            // Keep the steps on screen, marking where the build stopped.
            setBuild({ tracker: { ...tracker, failed: true }, world: requestedWorld });
            throw new Error(buildOutcome);
          }
          await new Promise((resolve) => setTimeout(resolve, BUILD_POLL_MS));
        }
        setBuild(null);
        response = await request();
      }
      if (response.status === 503) throw new Error("launch-unavailable");
      if (!response.ok) throw new Error("The sandbox could not launch. Try again.");
      const data: unknown = await response.json();
      if (typeof data !== "object" || data === null || !("url" in data) || typeof data.url !== "string"
        || !("expiresAt" in data) || typeof data.expiresAt !== "string"
        || !Number.isFinite(Date.parse(data.expiresAt))
        || Date.parse(data.expiresAt) <= Date.now()
        || !("world" in data) || data.world !== requestedWorld) throw new Error("The launch could not be verified. Try again.");
      const requestedProvider = provider?.id ?? "freestyle";
      if ((provider && (!("provider" in data) || data.provider !== provider.id))
        || !previewAccessUrl(requestedProvider, data.url, world === "desktop")) throw new Error("The launch could not be verified. Try again.");
      const outputs = parsePreviewOutputs("outputs" in data ? data.outputs : {}, requestedProvider);
      if (desktop && (!outputs.desktopUrl || !previewAccessUrl(requestedProvider, outputs.desktopUrl.value, true))) throw new Error("The desktop could not launch. Try again.");
      setSession({ url: desktop ? outputs.desktopUrl.value : data.url, expiresAt: data.expiresAt, outputs, desktop, world, providerLabel: label });
      setReveal(false); setExpired(false);
    } catch (failure) {
      if (!buildOutcome) setBuild(null);
      setError(failure instanceof Error && failure.message === "launch-unavailable" ? `${label} launches are unavailable. Reload to check access, or ask the review app owner to check provider configuration.`
        : buildOutcome === "still-building" ? "This commit's sandbox is still building. Try again in a few minutes."
        : buildOutcome === "failed" ? "This commit's sandbox could not be built. Try again; if it fails again, ask the review app owner to check the review app logs."
        : failure instanceof TypeError ? "The reviewer could not be reached. Reload this page and try again."
        : "The sandbox could not launch. Try again.");
    } finally { setBusy(false); }
  }

  const services: [string, { value: string }][] = session ? Object.entries(session.outputs).filter(([, entry]) => entry.group === "Services") : [];
  if (session && !services.length) services.push(["webUrl", { value: session.url }]);
  const serviceNames: Record<string, string> = { webUrl: "OpenWork", denWeb: "Den dashboard", denApi: "Den API", openworkUrl: "OpenWork engine", gatewayUrl: "AI Gateway", desktopUrl: "Desktop app" };
  function field(key: string, label: string, value: string, secret = false) {
    return <div className="connection-field" key={key}>
      <div className="preview-launch-row"><strong>{label}</strong><CopyButton label={`Copy ${label}`} value={value} /></div>
      <code>{secret && !reveal ? "••••••••" : value}</code>
    </div>;
  }

  return (
    <div className="preview-launch">
      <h2>Your sandbox</h2>

      {providers && providers.length > 1 && <label>Provider <select aria-label="Sandbox provider" value={providerId} disabled={busy} onChange={(event) => {
        const next = providers.find((option) => option.id === event.target.value);
        if (!next) return;
        setProviderId(next.id); setWorld("app-web"); setError(null); setBuild(null);
      }}>
        {providers.map((option) => <option key={option.id} value={option.id}>{option.label}{option.connected ? "" : " (unavailable)"}</option>)}
      </select></label>}
      <label>World <select aria-label="Preview world" value={world} disabled={busy} onChange={(event) => { setWorld(event.target.value); setError(null); setBuild(null); }}>
        <option value="app-web" disabled={provider && !provider.worlds.includes("app-web")}>OpenWork web</option>
        <option value="desktop" disabled={provider && !provider.worlds.includes("desktop")}>Desktop only (signed out)</option>
        <option value="acme-web" disabled={provider && !provider.worlds.includes("acme-web")}>ACME web (full stack)</option>
        <option value="acme-desktop" disabled={provider && (provider.id === "daytona" || !provider.worlds.includes("acme-web"))}>ACME desktop (full stack)</option>
      </select></label>
      <div className="preview-launch-actions">
        {session && !expired && <a className="preview-open" href={session.url} target="_blank" rel="noreferrer">{session.desktop ? "Open desktop" : "Open sandbox"}</a>}
        <button type="button" className={session && !expired ? "quiet" : "primary"} onClick={launch} disabled={!available || busy} aria-busy={busy} aria-describedby="preview-state">{expired ? "Launch again" : session ? "Launch another" : `Launch in ${label}`}</button>
      </div>
      {(!build || error) && <p id="preview-state" className={error ? "preview-error" : "preview-state"} role={error ? "alert" : "status"}>
        {!available ? provider?.reason ?? `${label} is not connected. The review app owner can connect it.`
          : error ?? (busy ? "Your new sandbox is starting. This can take a few minutes."
            : expired ? "Expired. Launch again to create a fresh sandbox." : session ? `${session.providerLabel} · ${session.world} · Expires ${new Date(session.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Fresh sandbox per launch · 2-hour lifetime")}
      </p>}
      {build && <BuildReadiness tracker={build.tracker} world={build.world} worldName={WORLD_NAMES[build.world] ?? build.world} />}
      {session && !expired && <section aria-label="Your connection details">
        <div className="preview-launch-row">
          <CopyButton label="Copy all connection details" value={JSON.stringify({ sandboxUrl: session.url, ...Object.fromEntries(Object.entries(session.outputs).map(([key, entry]) => [key, entry.value])) }, null, 2)} />
          <button type="button" className="quiet" onClick={() => setReveal(!reveal)}>{reveal ? "Hide credentials" : "Show credentials"}</button>
        </div>
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
              <div className="preview-launch-row"><a href={entry.value} target="_blank" rel="noreferrer">Open {name}</a><CopyButton label={`Copy ${name} URL`} value={entry.value} /></div>
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
        {provider?.id === "daytona" ? <p>Daytona opens a fresh OpenWork web app and local engine from this report’s commit. Desktop and ACME worlds are not available on Daytona yet. Each launch has private access and a two-hour lifetime. Launching a sandbox does not run verification tests.</p> : <p>OpenWork web runs the OpenWork web app and its local engine. Desktop only opens the real desktop app from this commit with a fresh, signed-out profile: no Den, databases, AI Gateway, demo accounts, or separate web preview. Its local engine and internal renderer belong to the desktop app. ACME web and ACME desktop keep the full stack with demo accounts and a simulated model upstream. Each launch restores this commit’s snapshot into a separate sandbox; the first launch of a commit builds that snapshot (usually about 2 minutes for OpenWork web and 6 for ACME) unless its evidence report already prepared it. Sandboxes expire after two hours; work is not saved. Launching a sandbox does not run verification tests.</p>}
      </details>
    </div>
  );
}
