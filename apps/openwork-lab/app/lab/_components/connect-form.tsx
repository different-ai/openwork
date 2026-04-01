"use client";

import { ArrowRight, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

export function ConnectForm() {
  const router = useRouter();
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [hostToken, setHostToken] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/lab/connection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl, token, hostToken, workspaceId }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error || "Failed to connect to OpenWork.");
      }
      router.push("/lab");
      router.refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="lab-app-shell">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <span className="lab-top-glow" />
        <span className="lab-side-glow" />
      </div>

      <section className="lab-connect-frame relative z-10">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-4">
            <div className="lab-eyebrow">OpenWork Lab</div>
            <h1 className="lab-title">One workspace. One session surface. No switcher noise.</h1>
            <p className="lab-copy max-w-2xl">
              OpenWork Lab is a from-scratch single-workspace shell. Point it at one OpenWork server,
              keep the session readable, and do everything else from a calm support surface.
            </p>
          </div>
          <div className="lab-badge hidden md:inline-flex">
            <Sparkles className="h-4 w-4" />
            den-web-inspired shell
          </div>
        </div>

        <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
          <form className="lab-panel space-y-5" onSubmit={handleSubmit}>
            <div className="grid gap-2">
              <label className="lab-label">OpenWork server URL</label>
              <input
                className="lab-input"
                placeholder="http://127.0.0.1:8787 or http://host:8787/w/ws_xxx"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <label className="lab-label">Client token</label>
              <input
                className="lab-input font-mono"
                placeholder="Bearer token from openwork-server"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <label className="lab-label">Owner / host token</label>
              <input
                className="lab-input font-mono"
                placeholder="Optional, but needed for elevated writes and reloads"
                value={hostToken}
                onChange={(event) => setHostToken(event.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <label className="lab-label">Workspace ID</label>
              <input
                className="lab-input font-mono"
                placeholder="Optional when the server already exposes one workspace"
                value={workspaceId}
                onChange={(event) => setWorkspaceId(event.target.value)}
              />
            </div>

            {error ? <div className="lab-error-banner">{error}</div> : null}

            <button type="submit" className="lab-button-primary w-full" disabled={busy}>
              {busy ? "Connecting…" : "Open workspace"}
              <ArrowRight className="h-4 w-4" />
            </button>
          </form>

          <div className="lab-panel-subtle space-y-4">
            <div>
              <div className="lab-eyebrow">What this lab keeps</div>
              <h2 className="text-2xl font-semibold tracking-tight text-[var(--dls-text-primary)]">
                The OpenWork runtime model stays intact.
              </h2>
            </div>
            <ul className="space-y-3 text-sm leading-7 text-[var(--dls-text-secondary)]">
              <li>• Session-first UX with readable message flow.</li>
              <li>• OpenWork server remains the control surface.</li>
              <li>• Remote connect still works through URL + token.</li>
              <li>• Settings shrink, but permissions, config, and reload stay accessible.</li>
              <li>• Electron wrapper sits on top of the web app instead of redefining product logic.</li>
            </ul>
          </div>
        </div>
      </section>
    </main>
  );
}
