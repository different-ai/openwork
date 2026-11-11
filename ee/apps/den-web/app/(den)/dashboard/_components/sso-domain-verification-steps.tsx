"use client";

import { CircleAlert, Copy, KeyRound, RefreshCw, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { DenButton } from "../../_components/ui/button";
import type { DenOrgSsoConnection } from "../../_lib/den-org";

/**
 * ssoOidcSetupCheck: the domain verification panel says what to do next after
 * a save, and when a check fails, which record failed and how.
 */
export type DomainVerificationProblem = {
  reason: "record_missing" | "value_mismatch" | "lookup_failed" | "expired";
  domain: string | null;
  dnsName: string | null;
  found: string | null;
  checkedAt: string;
  message: string;
};

const REASONS: ReadonlyArray<DomainVerificationProblem["reason"]> = ["record_missing", "value_mismatch", "lookup_failed", "expired"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringOrNull(value: unknown) {
  return typeof value === "string" ? value : null;
}

function readReason(value: unknown) {
  return REASONS.find((reason) => reason === value) ?? null;
}

/** The reason a failed verify-domain response gives, when the server explained it. */
export function parseDomainVerificationProblem(payload: unknown): DomainVerificationProblem | null {
  const problem = isRecord(payload) ? payload.domainVerification : null;
  const reason = isRecord(problem) ? readReason(problem.reason) : null;
  if (!isRecord(problem) || !reason) return null;
  const checkedAt = stringOrNull(problem.checkedAt);
  const message = stringOrNull(problem.message);
  if (!checkedAt || !message) return null;
  return {
    reason,
    domain: stringOrNull(problem.domain),
    dnsName: stringOrNull(problem.dnsName),
    found: stringOrNull(problem.found),
    checkedAt,
    message,
  };
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function Mono({ children }: { children: ReactNode }) {
  return <code className="break-all text-[13px]">{children}</code>;
}

function ProblemNotice({ problem }: { problem: DomainVerificationProblem }) {
  const time = formatTime(problem.checkedAt);
  const at = time ? ` at ${time}` : "";
  const name = problem.dnsName ? <Mono>{problem.dnsName}</Mono> : "the record";
  const content: { title: string; body: ReactNode } = (() => {
    switch (problem.reason) {
      case "record_missing":
        return {
          title: "No TXT record found yet",
          body: (
            <>
              <p>We looked up {name}{at} and it has no TXT record.</p>
              <p>New DNS records can take up to an hour to appear. If someone else manages DNS for {problem.domain ?? "your domain"}, send them the values below.</p>
            </>
          ),
        };
      case "value_mismatch":
        return {
          title: "The TXT record has a different value",
          body: (
            <>
              <p>We found a record at {name}{at}, but its value is <Mono>{problem.found ?? "different"}</Mono>.</p>
              <p>Replace it with the value below, then verify again.</p>
            </>
          ),
        };
      case "lookup_failed":
        return {
          title: "We couldn't look up the record",
          body: <p>OpenWork could not reach DNS for {name}{at}. Try again in a few minutes.</p>,
        };
      case "expired":
        return {
          title: "This value has expired",
          body: <p>Values last seven days. Get a new value, replace the TXT record with it, then verify again.</p>,
        };
    }
  })();

  return (
    <div role="alert" data-testid="sso-domain-verification-problem" className="flex items-start gap-3 border-b border-[var(--dls-border)] bg-red-50 px-5 py-4 text-[14px] text-red-800">
      <CircleAlert className="mt-0.5 shrink-0" size={18} aria-hidden="true" />
      <div>
        <p className="font-semibold">{content.title}</p>
        <div className="mt-1 leading-6">{content.body}</div>
      </div>
    </div>
  );
}

const STEPS = [
  { title: "Add the record", body: "Create this TXT record where your domain's DNS is managed." },
  { title: "Wait for it to go live", body: "Usually a few minutes, sometimes up to an hour." },
  { title: "Verify domain", body: "We check the record, then you can test and enable SSO." },
];

export function SsoDomainVerificationSteps({
  connection,
  multiple,
  token,
  justSaved,
  problem,
  verifying,
  requesting,
  canManage,
  copiedValue,
  onVerify,
  onRequestValue,
  onCopy,
}: {
  connection: DenOrgSsoConnection;
  multiple: boolean;
  token: string | null;
  /** The connection was saved in this visit: lead with what comes next. */
  justSaved: boolean;
  problem: DomainVerificationProblem | null;
  verifying: boolean;
  requesting: boolean;
  canManage: boolean;
  copiedValue: string | null;
  onVerify: () => void;
  onRequestValue: () => void;
  onCopy: (value: string, key: string) => void;
}) {
  const domains = connection.domains.join(", ") || connection.domain;
  const needsValue = !token || problem?.reason === "expired";
  const records = [
    { label: "Record type", value: "TXT", key: "domain-record-type" },
    { label: "Host / name", value: connection.domainVerificationHost, key: "domain-record-host" },
    ...(connection.domainVerificationDnsNames.length > 1
      ? connection.domainVerificationDnsNames.map((record) => ({ label: `Full DNS name for ${record.domain}`, value: record.dnsName, key: `domain-record-name-${record.domain}` }))
      : [{ label: "Full DNS name", value: connection.domainVerificationDnsName, key: "domain-record-name" }]),
    { label: "Value", value: problem?.reason === "expired" ? null : token, key: "domain-token" },
  ];

  return (
    <section id="sso-domain-verification" data-testid="sso-domain-verification" className="scroll-mt-6 overflow-hidden rounded-[24px] border border-[var(--dls-border)] bg-[var(--dls-surface)] text-[14px] text-[var(--dls-text-primary)]">
      <div className="flex flex-col gap-4 border-b border-[var(--dls-border)] bg-[var(--dls-hover)] px-5 py-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 rounded-full bg-amber-900 p-2 text-amber-50"><ShieldAlert size={18} aria-hidden="true" /></span>
          <div>
            <p className="text-[16px] font-semibold tracking-[-0.02em]">{justSaved && !problem ? "Connection saved. Next, verify your domain" : "Verify your domain"}</p>
            <p className="mt-1 max-w-2xl leading-6 text-[var(--dls-text-secondary)]">
              {multiple ? "This connection stays off" : "SSO stays off"} until a DNS record proves that your workspace controls <strong>{domains}</strong>.{connection.domains.length > 1 ? " Add the same TXT value at each domain's record name." : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {needsValue ? (
            <DenButton variant="primary" icon={KeyRound} onClick={onRequestValue} disabled={requesting || !canManage}>
              {requesting ? "Getting value..." : problem?.reason === "expired" ? "Get a new value" : "Get record value"}
            </DenButton>
          ) : (
            <DenButton variant="primary" icon={RefreshCw} onClick={onVerify} disabled={verifying || !canManage}>
              {verifying ? "Verifying..." : problem ? "Verify again" : "Verify domain"}
            </DenButton>
          )}
        </div>
      </div>

      {problem ? <ProblemNotice problem={problem} /> : null}

      <ol className="grid gap-px border-b border-[var(--dls-border)] bg-[var(--dls-border)] text-[13px] leading-5 sm:grid-cols-3">
        {STEPS.map((step, index) => (
          <li key={step.title} className="flex gap-3 bg-[var(--dls-surface)] px-5 py-4">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--dls-border)] text-[12px] font-semibold">{index + 1}</span>
            <div>
              <p className="font-semibold">{step.title}</p>
              <p className="text-[var(--dls-text-secondary)]">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="grid gap-px bg-[var(--dls-border)] md:grid-cols-2">
        {records.map((record) => (
          <div key={record.key} className="bg-[var(--dls-surface)] px-5 py-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-[13px] font-medium text-[var(--dls-text-secondary)]">{record.label}</p>
              {record.value ? (
                <button type="button" className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium text-[var(--dls-text-primary)] transition-colors hover:bg-[var(--dls-active)]" onClick={() => onCopy(record.value ?? "", record.key)}>
                  <Copy size={13} aria-hidden="true" /> {copiedValue === record.key ? "Copied" : "Copy"}
                </button>
              ) : null}
            </div>
            <code className="block break-all text-[13px] leading-6 text-gray-800">{record.value ?? (problem?.reason === "expired" ? "Get a new value to show it" : "Get the record value to show it")}</code>
          </div>
        ))}
      </div>

      <div className="grid gap-3 px-5 py-4 text-[13px] leading-5 text-[var(--dls-text-secondary)] sm:grid-cols-2">
        <p><strong className="text-[var(--dls-text-primary)]">DNS providers differ:</strong> use the host value when your provider appends the domain automatically; otherwise use the full DNS name.</p>
        <p><strong className="text-[var(--dls-text-primary)]">One-time proof:</strong> the value lasts seven days and stays the same when you edit the connection. After verification succeeds, you may remove the record.</p>
      </div>
    </section>
  );
}
