"use client";

import { CheckCircle2, Copy, ExternalLink, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getErrorMessage, requestJson } from "../_lib/den-flow";
import { OnboardingShell } from "./onboarding-shell";
import { OrganizationBrandIdentity, type OrganizationBrand } from "./organization-brand-identity";

const CONNECT_CODE_PATTERN = /^[A-Za-z0-9_-]{24,128}$/;
const RETURN_TO_OPENWORK_URL = "openwork://open";

type ActivationDetails = {
  status: "pending" | "connected";
  organizationName: string;
  brand: OrganizationBrand;
  apiBaseUrl: string;
  expiresAt: string;
};

type ActivationState =
  | { kind: "loading" }
  | { kind: "ready"; details: ActivationDetails }
  | { kind: "expired" }
  | { kind: "error"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseActivationDetails(value: unknown): ActivationDetails | null {
  if (!isRecord(value) || (value.status !== "pending" && value.status !== "connected")) return null;
  if (!isRecord(value.claims) || !isRecord(value.claims.org) || !isRecord(value.claims.brand) || !isRecord(value.claims.den)) {
    return null;
  }

  const organizationName = value.claims.org.name;
  const appName = value.claims.brand.appName;
  const logoUrl = value.claims.brand.logoUrl;
  const iconUrl = value.claims.brand.iconUrl;
  const apiBaseUrl = value.claims.den.apiBaseUrl;
  const expiresAt = value.expiresAt;
  if (
    typeof organizationName !== "string"
    || typeof appName !== "string"
    || (logoUrl !== null && typeof logoUrl !== "string")
    || (iconUrl !== null && typeof iconUrl !== "string")
    || typeof apiBaseUrl !== "string"
    || typeof expiresAt !== "string"
  ) {
    return null;
  }

  try {
    new URL(apiBaseUrl);
    if (logoUrl) new URL(logoUrl);
    if (iconUrl) new URL(iconUrl);
    if (Number.isNaN(Date.parse(expiresAt))) return null;
  } catch {
    return null;
  }

  return {
    status: value.status,
    organizationName,
    brand: { appName, logoUrl, iconUrl },
    apiBaseUrl,
    expiresAt,
  };
}

function connectUrlFor(code: string, apiBaseUrl: string) {
  const url = new URL("openwork://connect");
  url.searchParams.set("code", code);
  url.searchParams.set("apiBaseUrl", apiBaseUrl);
  return url.toString();
}

export function ActivationScreen() {
  const searchParams = useSearchParams();
  const code = searchParams.get("code")?.trim() ?? "";
  const [state, setState] = useState<ActivationState>({ kind: "loading" });
  const [openAttempted, setOpenAttempted] = useState(false);
  const [copied, setCopied] = useState<"connect" | "return" | null>(null);

  useEffect(() => {
    if (!CONNECT_CODE_PATTERN.test(code)) {
      setState({ kind: "error", message: "This activation link is incomplete. Return to the install page and try again." });
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    async function poll() {
      try {
        const { response, payload } = await requestJson(
          "/v1/install-connect/status",
          { method: "POST", body: JSON.stringify({ code }) },
          12000,
        );
        if (cancelled) return;
        if (response.status === 410) {
          setState({ kind: "expired" });
          return;
        }
        if (!response.ok) {
          setState({
            kind: "error",
            message: getErrorMessage(payload, "This activation link could not be opened."),
          });
          return;
        }

        const details = parseActivationDetails(payload);
        if (!details) {
          setState({ kind: "error", message: "This activation link returned incomplete setup details." });
          return;
        }
        setState({ kind: "ready", details });
        if (details.status === "pending") {
          timer = window.setTimeout(() => void poll(), 2000);
        }
      } catch {
        if (!cancelled) {
          timer = window.setTimeout(() => void poll(), 4000);
        }
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [code]);

  async function copyLink(kind: "connect" | "return", value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1800);
  }

  if (state.kind === "loading") {
    return (
      <OnboardingShell state="activation-loading" width="wide">
        <section className="grid justify-items-center gap-4 rounded-[1.75rem] border border-slate-200/80 bg-white p-8 text-center" data-testid="activation-page">
          <LoaderCircle className="size-6 animate-spin text-slate-500" aria-hidden="true" />
          <h1 className="den-title-lg">Preparing this computer.</h1>
          <p className="den-copy">Checking the secure activation link…</p>
        </section>
      </OnboardingShell>
    );
  }

  if (state.kind === "expired" || state.kind === "error") {
    const message = state.kind === "expired"
      ? "This one-time activation link has expired. Return to the install page and open OpenWork again."
      : state.message;
    return (
      <OnboardingShell state="activation-error" width="wide">
        <section className="grid gap-5 rounded-[1.75rem] border border-slate-200/80 bg-white p-6 sm:p-8" data-testid="activation-page">
          <p className="den-eyebrow">OpenWork Desktop</p>
          <h1 className="den-title-lg">This computer still needs approval.</h1>
          <p className="den-copy" role="alert">{message}</p>
          <button type="button" className="den-button-secondary w-fit" onClick={() => window.history.back()}>
            Return to the install page
          </button>
        </section>
      </OnboardingShell>
    );
  }

  const { details } = state;
  const connectUrl = connectUrlFor(code, details.apiBaseUrl);
  const connected = details.status === "connected";

  return (
    <OnboardingShell state={connected ? "activation-connected" : "activation-pending"} width="wide">
      <section
        className="grid gap-6 rounded-[1.75rem] border border-slate-200/80 bg-white p-6 sm:p-8 md:p-10"
        data-testid="activation-page"
      >
        <div className="grid justify-items-start gap-3">
          <p className="den-eyebrow">{details.brand.appName} Desktop</p>
          <h1 className="m-0 text-[2rem] font-semibold leading-[1.04] tracking-[-0.05em] text-slate-950 sm:text-[2.5rem]">
            {connected ? "Connected to " : "Connect this computer to "}
            <OrganizationBrandIdentity organizationName={details.organizationName} brand={details.brand} />
          </h1>
          <p className="den-copy">
            {connected
              ? `${details.organizationName}'s setup and branding are ready in ${details.brand.appName}.`
              : `OpenWork will show ${details.organizationName} and its server before anything changes.`}
          </p>
        </div>

        {connected ? (
          <div className="grid gap-4" aria-live="polite">
            <div className="flex items-center gap-3 rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800" data-testid="activation-connected">
              <CheckCircle2 className="size-5 shrink-0" aria-hidden="true" />
              Connected to {details.organizationName}
            </div>
            <a className="den-button-primary w-full justify-center sm:w-fit" href={RETURN_TO_OPENWORK_URL} data-testid="activation-return-openwork">
              Return to OpenWork
              <ExternalLink className="size-4" aria-hidden="true" />
            </a>
            <div className="grid gap-2 rounded-2xl bg-slate-50 p-4">
              <p className="m-0 text-sm text-slate-600">Nothing opened? Copy this OpenWork link and open it from your browser.</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input className="den-input min-w-0 flex-1 text-xs" value={RETURN_TO_OPENWORK_URL} readOnly onFocus={(event) => event.currentTarget.select()} />
                <button type="button" className="den-button-secondary sm:w-auto" onClick={() => void copyLink("return", RETURN_TO_OPENWORK_URL)}>
                  <Copy className="size-4" aria-hidden="true" />
                  {copied === "return" ? "Copied" : "Copy link"}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="grid gap-4" aria-live="polite">
            <button
              type="button"
              className="den-button-primary w-full justify-center sm:w-fit"
              data-testid="activation-open-openwork"
              onClick={() => {
                setOpenAttempted(true);
                window.location.assign(connectUrl);
              }}
            >
              Open OpenWork
              <ExternalLink className="size-4" aria-hidden="true" />
            </button>
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              {openAttempted ? "Waiting for OpenWork to accept this setup…" : "Waiting for your approval…"}
            </div>
            {openAttempted ? (
              <div className="grid gap-2 rounded-2xl bg-slate-50 p-4" data-testid="activation-open-fallback">
                <p className="m-0 text-sm text-slate-600">OpenWork did not appear? Copy this one-time link and open it anywhere that handles OpenWork links.</p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input className="den-input min-w-0 flex-1 text-xs" value={connectUrl} readOnly onFocus={(event) => event.currentTarget.select()} />
                  <button type="button" className="den-button-secondary sm:w-auto" onClick={() => void copyLink("connect", connectUrl)}>
                    <Copy className="size-4" aria-hidden="true" />
                    {copied === "connect" ? "Copied" : "Copy OpenWork link"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </OnboardingShell>
  );
}
