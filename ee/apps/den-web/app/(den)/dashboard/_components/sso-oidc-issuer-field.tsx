"use client";

import { ChevronRight, CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";

/**
 * ssoOidcSetupCheck: the OIDC issuer field that reports what it found.
 *
 * The administrator gives the issuer or the discovery URL; the line under the
 * field says what the provider answered. The field owns no data: the form
 * passes the check result in and decides when to check.
 */

export type OidcIssuerEndpoints = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksEndpoint: string;
  userInfoEndpoint: string | null;
};

export type OidcIssuerCheck =
  | { state: "idle" }
  | { state: "checking"; host: string }
  | { state: "found"; issuer: string; fromDiscoveryUrl: boolean; endpoints: OidcIssuerEndpoints }
  | { state: "mismatch"; reportedIssuer: string }
  | { state: "failed"; message: string };

const FIELD_CLASS = "h-auto rounded-[18px] py-3";

const ISSUER_EXAMPLES = [
  { provider: "Microsoft Entra ID", issuer: "https://login.microsoftonline.com/{tenant-id}/v2.0" },
  { provider: "Okta", issuer: "https://{your-domain}.okta.com" },
  { provider: "Google Workspace", issuer: "https://accounts.google.com" },
  { provider: "Keycloak", issuer: "https://{host}/realms/{realm}" },
];

function Disclosure({ label, children, open, onToggle, testId }: { label: string; children: ReactNode; open: boolean; onToggle: () => void; testId?: string }) {
  const panelId = useId();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        data-testid={testId}
        className="flex items-center gap-1.5 rounded-md py-1 text-[13px] font-medium text-gray-600 hover:text-gray-900"
      >
        <ChevronRight size={14} aria-hidden="true" className={`transition-transform ${open ? "rotate-90" : ""}`} />
        {label}
      </button>
      {open ? <div id={panelId} className="mt-2">{children}</div> : null}
    </div>
  );
}

function EndpointList({ endpoints }: { endpoints: OidcIssuerEndpoints }) {
  const rows = [
    { label: "Authorization", value: endpoints.authorizationEndpoint },
    { label: "Token", value: endpoints.tokenEndpoint },
    { label: "JWKS", value: endpoints.jwksEndpoint },
    ...(endpoints.userInfoEndpoint ? [{ label: "UserInfo", value: endpoints.userInfoEndpoint }] : []),
  ];
  return (
    <dl className="grid gap-x-4 gap-y-1.5 rounded-[14px] border border-gray-200 px-4 py-3 text-[13px] sm:grid-cols-[110px_1fr]">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-gray-500">{row.label}</dt>
          <dd className="min-w-0 break-all font-mono text-[12px] text-gray-800">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function CheckLine({ check, onUseIssuer, disabled }: { check: OidcIssuerCheck; onUseIssuer: (issuer: string) => void; disabled: boolean }) {
  const [endpointsOpen, setEndpointsOpen] = useState(false);

  if (check.state === "idle") return null;

  if (check.state === "checking") {
    return (
      <p role="status" className="flex items-center gap-2 text-[13px] text-gray-600">
        <LoaderCircle size={14} aria-hidden="true" className="animate-spin" />
        Checking {check.host}
      </p>
    );
  }

  if (check.state === "found") {
    return (
      <div role="status" className="space-y-1.5" data-testid="sso-oidc-issuer-found">
        <p className="flex items-center gap-2 text-[13px] text-gray-800">
          <CircleCheck size={14} aria-hidden="true" className="shrink-0 text-[var(--ow-success)]" />
          Sign-in settings found
        </p>
        {check.fromDiscoveryUrl ? (
          <p className="pl-[22px] text-[13px] text-gray-600">
            Issuer: <span className="break-all font-mono text-[12px] text-gray-800">{check.issuer}</span>
          </p>
        ) : null}
        <div className="pl-[22px]">
          <Disclosure label="Endpoints found" open={endpointsOpen} onToggle={() => setEndpointsOpen((value) => !value)}>
            <EndpointList endpoints={check.endpoints} />
          </Disclosure>
        </div>
      </div>
    );
  }

  if (check.state === "mismatch") {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-[var(--ow-danger)]" data-testid="sso-oidc-issuer-mismatch">
        <p className="flex min-w-0 items-start gap-2">
          <CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span className="min-w-0">
            This provider reports its issuer as <span className="break-all font-mono text-[12px]">{check.reportedIssuer}</span>
          </span>
        </p>
        {/* Negative margin: the button keeps its hit area without making the line taller. */}
        <span className="-my-1.5 flex"><DenButton variant="secondary" size="sm" onClick={() => onUseIssuer(check.reportedIssuer)} disabled={disabled}>Use this issuer</DenButton></span>
      </div>
    );
  }

  return (
    <p role="alert" className="flex items-start gap-2 text-[13px] text-[var(--ow-danger)]" data-testid="sso-oidc-issuer-error">
      <CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span className="min-w-0 break-words">{check.message}</span>
    </p>
  );
}

export type OidcIssuerFieldProps = {
  value: string;
  onChange: (value: string) => void;
  /** The field lost focus or received a paste: check what is in it now. */
  onCheck: (value: string) => void;
  check: OidcIssuerCheck;
  onUseIssuer: (issuer: string) => void;
  manual: boolean;
  onManualChange: (manual: boolean) => void;
  /** The endpoint inputs, shown while entering endpoints manually. */
  manualFields: ReactNode;
  disabled?: boolean;
};

export function OidcIssuerField({ value, onChange, onCheck, check, onUseIssuer, manual, onManualChange, manualFields, disabled = false }: OidcIssuerFieldProps) {
  const inputId = useId();
  const [examplesOpen, setExamplesOpen] = useState(false);
  const invalid = check.state === "mismatch" || check.state === "failed";

  return (
    <div className="text-[14px] text-gray-700 md:col-span-2">
      <label htmlFor={inputId} className="mb-2 block font-medium">{manual ? "Issuer" : "Issuer or discovery URL"}</label>
      <DenInput
        id={inputId}
        className={`${FIELD_CLASS} ${invalid ? "border-red-300 focus:border-red-400" : ""}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={(event) => onCheck(event.target.value)}
        onPaste={(event) => {
          const input = event.currentTarget;
          // The pasted text lands after this event; read it on the next tick.
          window.setTimeout(() => onCheck(input.value), 0);
        }}
        placeholder="https://idp.example.com"
        aria-invalid={invalid}
        disabled={disabled}
        data-testid="sso-oidc-issuer"
      />
      {/* Reserved height: the rows below never move while a check starts or ends. */}
      <div className="mt-2 min-h-[20px]">
        <CheckLine check={check} onUseIssuer={onUseIssuer} disabled={disabled} />
      </div>
      <div className="mt-2 space-y-1">
        <Disclosure label="Where to find this" open={examplesOpen} onToggle={() => setExamplesOpen((open) => !open)}>
          <dl className="grid gap-x-4 gap-y-1.5 rounded-[14px] border border-gray-200 px-4 py-3 text-[13px] sm:grid-cols-[150px_1fr]">
            {ISSUER_EXAMPLES.map((example) => (
              <div key={example.provider} className="contents">
                <dt className="text-gray-500">{example.provider}</dt>
                <dd className="min-w-0 break-all font-mono text-[12px] text-gray-800">{example.issuer}</dd>
              </div>
            ))}
          </dl>
        </Disclosure>
        <Disclosure label="Enter endpoints manually" open={manual} onToggle={() => onManualChange(!manual)} testId="sso-oidc-manual-toggle">
          <div className="grid gap-4">{manualFields}</div>
        </Disclosure>
      </div>
    </div>
  );
}

/** Manual endpoints skip discovery, so a discovery URL as the issuer has to be caught here. */
export function manualIssuerProblem(issuer: string): string | null {
  return issuer.includes("/.well-known/") ? "The issuer is the provider's base address, not its discovery URL." : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Reads the answer of POST /v1/sso/oidc/check. An answer it cannot read says nothing. */
export function parseOidcIssuerCheck(payload: unknown): OidcIssuerCheck {
  if (!isRecord(payload)) return { state: "idle" };
  if (payload.ok === true) {
    const issuer = text(payload.issuer);
    const authorizationEndpoint = text(payload.authorizationEndpoint);
    const tokenEndpoint = text(payload.tokenEndpoint);
    const jwksEndpoint = text(payload.jwksEndpoint);
    if (!issuer || !authorizationEndpoint || !tokenEndpoint || !jwksEndpoint) return { state: "idle" };
    return {
      state: "found",
      issuer,
      fromDiscoveryUrl: payload.fromDiscoveryUrl === true,
      endpoints: { authorizationEndpoint, tokenEndpoint, jwksEndpoint, userInfoEndpoint: text(payload.userInfoEndpoint) },
    };
  }
  if (payload.ok !== false) return { state: "idle" };
  const reportedIssuer = text(payload.reportedIssuer);
  if (payload.code === "issuer_mismatch" && reportedIssuer) return { state: "mismatch", reportedIssuer };
  return { state: "failed", message: text(payload.message) ?? "OpenWork could not check this address." };
}

/** A refused save that points at the issuer: its message, for the line under the field. */
export function issuerProblemFromSave(payload: unknown): string | null {
  if (!isRecord(payload) || payload.error !== "invalid_request" || !Array.isArray(payload.details)) return null;
  for (const detail of payload.details) {
    if (isRecord(detail) && Array.isArray(detail.path) && detail.path[0] === "issuer") return text(detail.message);
  }
  return null;
}
