"use client";

import { useEffect, useMemo, useState } from "react";

type Organization = {
  id: string;
  slug?: string | null;
  name?: string | null;
  isActive?: boolean;
};

function getErrorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string") {
    return payload.message;
  }
  if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") {
    return payload.error;
  }
  return fallback;
}

async function requestJson(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const payload = await response.json().catch(() => null) as unknown;
  return { response, payload };
}

export default function McpSelectOrganizationPage() {
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState("");
  const [status, setStatus] = useState("Loading organizations...");
  const [busy, setBusy] = useState(false);
  const oauthQuery = useMemo(() => {
    if (typeof window === "undefined") return "";
    return window.location.search.replace(/^\?/, "");
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { response, payload } = await requestJson("/v1/me/orgs", { method: "GET" });
      if (cancelled) return;
      if (!response.ok) {
        setStatus(getErrorMessage(payload, "Sign in before authorizing MCP access."));
        return;
      }
      const list = payload && typeof payload === "object" && "orgs" in payload && Array.isArray(payload.orgs)
        ? payload.orgs.filter((entry): entry is Organization => Boolean(entry && typeof entry === "object" && "id" in entry && typeof entry.id === "string"))
        : [];
      setOrgs(list);
      setSelectedOrgId(list.find((org) => org.isActive)?.id ?? list[0]?.id ?? "");
      setStatus(list.length ? "Choose the workspace this MCP client can access." : "No organizations are available for this account.");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function continueFlow() {
    if (!selectedOrgId) return;
    setBusy(true);
    setStatus("Saving workspace selection...");
    const selected = orgs.find((org) => org.id === selectedOrgId);
    const active = await requestJson("/api/auth/organization/set-active", {
      method: "POST",
      body: JSON.stringify({ organizationId: selectedOrgId, organizationSlug: selected?.slug ?? null }),
    });
    if (!active.response.ok) {
      setBusy(false);
      setStatus(getErrorMessage(active.payload, "Failed to select organization."));
      return;
    }

    const continued = await requestJson("/api/auth/oauth2/continue", {
      method: "POST",
      body: JSON.stringify({ postLogin: true, oauth_query: oauthQuery }),
    });
    if (!continued.response.ok) {
      setBusy(false);
      setStatus(getErrorMessage(continued.payload, "Failed to continue OAuth authorization."));
      return;
    }

    if (continued.payload && typeof continued.payload === "object" && "url" in continued.payload && typeof continued.payload.url === "string") {
      window.location.href = continued.payload.url;
      return;
    }
    window.location.reload();
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-12 text-white">
      <section className="mx-auto max-w-xl rounded-3xl border border-white/10 bg-white/10 p-8 shadow-2xl">
        <p className="text-sm uppercase tracking-[0.3em] text-cyan-200">OpenWork MCP</p>
        <h1 className="mt-3 text-3xl font-semibold">Select a workspace</h1>
        <p className="mt-3 text-sm text-slate-300">{status}</p>
        <div className="mt-6 space-y-3">
          {orgs.map((org) => (
            <label key={org.id} className="flex cursor-pointer items-center gap-3 rounded-2xl border border-white/10 bg-slate-900/70 p-4">
              <input type="radio" checked={selectedOrgId === org.id} onChange={() => setSelectedOrgId(org.id)} />
              <span>{org.name || org.slug || org.id}</span>
            </label>
          ))}
        </div>
        <button className="mt-6 w-full rounded-2xl bg-cyan-300 px-4 py-3 font-semibold text-slate-950 disabled:opacity-50" disabled={busy || !selectedOrgId} onClick={continueFlow}>
          Continue
        </button>
      </section>
    </main>
  );
}
