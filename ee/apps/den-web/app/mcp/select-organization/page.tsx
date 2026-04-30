"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type Organization = {
  id: string;
  slug?: string | null;
  name?: string | null;
  role?: string | null;
  isActive?: boolean;
};

type FlowState =
  | "loading"
  | "ready"
  | "empty"
  | "submitting"
  | "redirecting"
  | "error";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readPayloadString(payload: unknown, key: "message" | "error" | "url") {
  if (isRecord(payload) && typeof payload[key] === "string") {
    return payload[key] as string;
  }
  return null;
}

function getErrorMessage(payload: unknown, fallback: string) {
  return (
    readPayloadString(payload, "message") ??
    readPayloadString(payload, "error") ??
    fallback
  );
}

async function requestJson(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  return { response, payload };
}

function getInitials(value: string) {
  const cleaned = value.trim();
  if (!cleaned) return "OW";
  const parts = cleaned.split(/\s+/).filter(Boolean);
  const initials =
    (parts[0]?.slice(0, 1) ?? "") + (parts[1]?.slice(0, 1) ?? "");
  return initials.toUpperCase() || cleaned.slice(0, 2).toUpperCase();
}

function formatRole(role: string | null | undefined) {
  if (!role) return "Member";
  return role
    .split(/[-_,\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function parseOrgs(payload: unknown): Organization[] {
  if (!isRecord(payload) || !Array.isArray(payload.orgs)) {
    return [];
  }

  const result: Organization[] = [];
  for (const entry of payload.orgs) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    result.push({
      id: entry.id,
      slug: typeof entry.slug === "string" ? entry.slug : null,
      name: typeof entry.name === "string" ? entry.name : null,
      role: typeof entry.role === "string" ? entry.role : null,
      isActive: entry.isActive === true,
    });
  }
  return result;
}

export default function McpSelectOrganizationPage() {
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState("");
  const [flowState, setFlowState] = useState<FlowState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const oauthQuery = useMemo(() => {
    if (typeof window === "undefined") return "";
    return window.location.search.replace(/^\?/, "");
  }, []);
  const params = useMemo(() => new URLSearchParams(oauthQuery), [oauthQuery]);
  const requestedScope = useMemo(
    () => params.get("scope") ?? "openid profile email mcp:read",
    [params],
  );
  const selectedOrg = useMemo(
    () => orgs.find((org) => org.id === selectedOrgId) ?? null,
    [orgs, selectedOrgId],
  );
  const isBusy = flowState === "submitting" || flowState === "redirecting";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { response, payload } = await requestJson("/api/den/v1/me/orgs", {
        method: "GET",
      });
      if (cancelled) return;

      if (!response.ok) {
        setErrorMessage(
          getErrorMessage(payload, "Sign in before authorizing MCP access."),
        );
        setFlowState("error");
        return;
      }

      const list = parseOrgs(payload);
      setOrgs(list);
      setSelectedOrgId(
        list.find((org) => org.isActive)?.id ?? list[0]?.id ?? "",
      );
      setFlowState(list.length ? "ready" : "empty");
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  async function continueFlow() {
    if (!selectedOrgId) return;
    setFlowState("submitting");
    setErrorMessage(null);

    const active = await requestJson("/api/auth/organization/set-active", {
      method: "POST",
      body: JSON.stringify({
        organizationId: selectedOrgId,
        organizationSlug: selectedOrg?.slug ?? null,
      }),
    });
    if (!active.response.ok) {
      setFlowState("ready");
      setErrorMessage(
        getErrorMessage(active.payload, "Failed to select organization."),
      );
      return;
    }

    const continued = await requestJson("/api/auth/oauth2/consent", {
      method: "POST",
      body: JSON.stringify({
        accept: true,
        scope: requestedScope,
        oauth_query: oauthQuery,
      }),
    });
    if (!continued.response.ok) {
      setFlowState("ready");
      setErrorMessage(
        getErrorMessage(
          continued.payload,
          "Failed to continue OAuth authorization.",
        ),
      );
      return;
    }

    const redirectUrl = readPayloadString(continued.payload, "url");
    setFlowState("redirecting");
    if (redirectUrl) {
      window.location.href = redirectUrl;
      return;
    }
    window.location.reload();
  }

  async function cancelFlow() {
    setFlowState("submitting");
    setErrorMessage(null);

    const denied = await requestJson("/api/auth/oauth2/consent", {
      method: "POST",
      body: JSON.stringify({
        accept: false,
        scope: requestedScope,
        oauth_query: oauthQuery,
      }),
    });

    const redirectUrl = readPayloadString(denied.payload, "url");
    if (redirectUrl) {
      setFlowState("redirecting");
      window.location.href = redirectUrl;
      return;
    }

    setFlowState(orgs.length ? "ready" : "empty");
    setErrorMessage("Authorization cancelled. You can close this tab.");
  }

  const introCopy =
    flowState === "loading"
      ? "Loading the workspaces you can access..."
      : flowState === "empty"
        ? "You don't belong to any workspaces yet. Create one before authorizing the MCP client."
        : flowState === "redirecting"
          ? "Finishing authorization and sending you back to the MCP client now."
          : flowState === "submitting"
            ? "Authorizing the MCP client..."
            : "The MCP client will only see data for the workspace you choose.";

  const primaryLabel =
    flowState === "submitting"
      ? "Authorizing..."
      : flowState === "redirecting"
        ? "Redirecting..."
        : "Authorize and continue";

  return (
    <main className="den-page flex min-h-screen w-full items-center py-6">
      <section className="grid w-full items-stretch gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)]">
        <aside className="order-2 lg:order-1">
          <div className="den-frame relative h-full min-h-[300px] overflow-hidden bg-[#011627] px-7 py-8 text-white md:px-10 md:py-10">
            <div
              aria-hidden
              className="absolute inset-0 z-0 opacity-95"
              style={{
                backgroundImage:
                  "radial-gradient(circle at 18% 28%, rgba(99, 102, 241, 0.55), transparent 55%), radial-gradient(circle at 82% 62%, rgba(34, 211, 238, 0.4), transparent 55%), linear-gradient(160deg, #0F172A 0%, #1E1B4B 55%, #0F766E 100%)",
              }}
            />
            <div className="relative z-10 flex h-full flex-col justify-between gap-10">
              <div className="flex items-center gap-3">
                <img
                  src="/openwork-logo-transparent.svg"
                  alt="OpenWork"
                  className="h-9 w-auto"
                />
                <span className="text-[13px] font-medium text-white/80">
                  OpenWork Cloud
                </span>
              </div>
              <div className="grid gap-4">
                <span className="inline-flex w-fit rounded-full border border-white/20 bg-white/15 px-3 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-white backdrop-blur-md">
                  MCP authorization
                </span>
                <h1 className="max-w-[14ch] text-[2rem] font-semibold leading-[0.97] tracking-[-0.05em] md:text-[2.6rem]">
                  Pick the workspace this client can use.
                </h1>
                <p className="max-w-[34rem] text-[14px] leading-7 text-white/80">
                  The MCP client only sees data and tools for the workspace you
                  select here.
                </p>
              </div>
            </div>
          </div>
        </aside>

        <div className="order-1 lg:order-2">
          <div className="den-frame grid h-full gap-6 p-6 md:p-7">
            <div className="grid gap-3">
              <p className="den-eyebrow">Choose workspace</p>
              <h2 className="den-title-lg">
                Where should this client work?
              </h2>
              <p className="den-copy">{introCopy}</p>
            </div>

            {flowState === "loading" ? (
              <div className="h-2 overflow-hidden rounded-full bg-[var(--dls-hover)]">
                <div className="h-full w-1/3 animate-pulse rounded-full bg-[var(--dls-accent)]" />
              </div>
            ) : null}

            {flowState === "empty" ? (
              <div className="grid gap-3">
                <Link
                  href="/organization"
                  className="den-button-primary w-full sm:w-auto"
                >
                  Create your first workspace
                </Link>
                <p className="text-[13px] text-[var(--dls-text-secondary)]">
                  Once it is set up, run the MCP authorization again from your
                  client.
                </p>
              </div>
            ) : null}

            {orgs.length > 0 &&
            (flowState === "ready" ||
              flowState === "submitting" ||
              flowState === "redirecting") ? (
              <ul className="grid gap-2">
                {orgs.map((org) => {
                  const display = org.name || org.slug || org.id;
                  const isSelected = selectedOrgId === org.id;
                  return (
                    <li key={org.id}>
                      <label
                        className={`flex cursor-pointer items-center gap-3 rounded-2xl border bg-white px-4 py-3 transition-colors ${
                          isSelected
                            ? "border-[var(--dls-accent)] shadow-[0_0_0_4px_rgba(15,23,42,0.06)]"
                            : "border-[var(--dls-border)] hover:bg-[var(--dls-hover)]"
                        } ${isBusy ? "pointer-events-none opacity-70" : ""}`}
                      >
                        <input
                          type="radio"
                          name="mcp-organization"
                          checked={isSelected}
                          onChange={() => setSelectedOrgId(org.id)}
                          className="sr-only"
                          disabled={isBusy}
                        />
                        <span
                          aria-hidden
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#011627] text-[12px] font-semibold uppercase tracking-[0.08em] text-white"
                        >
                          {getInitials(display)}
                        </span>
                        <span className="grid flex-1 gap-0.5">
                          <span className="text-[15px] font-medium text-[var(--dls-text-primary)]">
                            {display}
                          </span>
                          <span className="text-[12px] text-[var(--dls-text-secondary)]">
                            {formatRole(org.role)}
                            {org.isActive ? " · Current workspace" : ""}
                          </span>
                        </span>
                        <span
                          aria-hidden
                          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                            isSelected
                              ? "border-[var(--dls-accent)] bg-[var(--dls-accent)]"
                              : "border-[var(--dls-border)] bg-white"
                          }`}
                        >
                          {isSelected ? (
                            <span className="h-2 w-2 rounded-full bg-white" />
                          ) : null}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            ) : null}

            {errorMessage ? (
              <div className="den-notice is-error">{errorMessage}</div>
            ) : null}

            <div className="grid gap-3 sm:flex sm:flex-wrap sm:items-center sm:justify-between">
              <button
                type="button"
                className="den-button-ghost w-full sm:w-auto"
                onClick={() => void cancelFlow()}
                disabled={isBusy || flowState === "loading"}
              >
                Cancel
              </button>
              <button
                type="button"
                className="den-button-primary w-full sm:w-auto"
                onClick={() => void continueFlow()}
                disabled={
                  isBusy ||
                  flowState === "loading" ||
                  flowState === "empty" ||
                  flowState === "error" ||
                  !selectedOrgId
                }
              >
                {primaryLabel}
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
