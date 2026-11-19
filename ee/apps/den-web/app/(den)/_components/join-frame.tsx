"use client";

import { useState, type ReactNode } from "react";
import { OrganizationBrandIdentity, type OrganizationBrand } from "./organization-brand-identity";
import { SetupFrame } from "./setup-frame";
import { SetupErrorLine, SetupFacts, SetupLetterTile, SetupLine, SetupPanelBody, SetupQuietButton } from "./setup-frame-parts";
import { DenButton } from "./ui/button";

/**
 * The invitation, sandbox and install screens use the same single panel as
 * sign-up and setup. Every screen composes these parts.
 */

const OPENWORK_MARK_SRC = "/openwork-mark.svg";

type JoinOrganization = { name: string; brand: OrganizationBrand };

/** The organization's own icon and logo or app name above the panel; OpenWork's when it has none. */
function JoinBrand({ organization }: { organization: JoinOrganization | null }) {
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);
  const iconUrl = organization?.brand.iconUrl ?? null;
  const iconSrc = iconUrl && iconUrl !== failedIconUrl ? iconUrl : OPENWORK_MARK_SRC;
  const custom = iconSrc !== OPENWORK_MARK_SRC;
  return (
    <>
      {/* Organization assets may be served by private on-prem hosts that are
          intentionally absent from this deployment's image allowlist. */}
      <img
        src={iconSrc}
        alt=""
        width={22}
        height={22}
        className={`object-contain ${custom ? "rounded-md" : ""}`}
        onError={() => { if (custom) setFailedIconUrl(iconSrc); }}
      />
      {organization?.brand.logoUrl
        ? <OrganizationBrandIdentity organizationName={organization.name} brand={organization.brand} className="max-h-6" />
        : <span>{organization?.brand.appName?.trim() || "OpenWork"}</span>}
    </>
  );
}

/** The setup panel alone, for screens that follow joining (install). */
export function JoinPanel({ state, organization = null, children }: { state: string; organization?: JoinOrganization | null; children: ReactNode }) {
  return (
    <div data-testid="join-org-root" data-state={state}>
      <SetupFrame single brand={<JoinBrand organization={organization} />} title="" description="">
        <SetupPanelBody>{children}</SetupPanelBody>
      </SetupFrame>
    </div>
  );
}

export function JoinFrame({ state, organization, testId, children }: {
  state: string;
  organization: JoinOrganization | null;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div data-testid="join-org-root" data-state={state}>
      <SetupFrame single title="" description="" brand={<JoinBrand organization={organization} />}>
        <div data-testid={testId}>
          <SetupPanelBody>{children}</SetupPanelBody>
        </div>
      </SetupFrame>
    </div>
  );
}

export function JoinHeading({ title, copy }: { title: ReactNode; copy?: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <h1 className="m-0 text-balance text-[20px] font-semibold leading-7 tracking-[-0.02em] text-[#0f172a] [overflow-wrap:anywhere]">{title}</h1>
      {copy ? <SetupLine muted>{copy}</SetupLine> : null}
    </div>
  );
}

export type JoinFact = { label: string; value: ReactNode };

/** The workspace as the letter tile used everywhere a workspace appears. */
export function JoinWorkspaceValue({ name }: { name: string }) {
  return <><SetupLetterTile name={name} /><span className="truncate">{name}</span></>;
}

export function JoinFacts({ rows, testId }: { rows: JoinFact[]; testId?: string }) {
  return <div data-testid={testId}><SetupFacts rows={rows} /></div>;
}

export function JoinText({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <SetupLine muted={muted}>{children}</SetupLine>;
}

export function JoinStrong({ children }: { children: ReactNode }) {
  return <span className="font-medium text-slate-950">{children}</span>;
}

export function JoinActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-col items-stretch gap-3" data-testid="join-org-actions">{children}</div>;
}

export function JoinPrimaryButton({ children, onClick, disabled, loading, testId, downloadHref }: {
  /** The installer this button starts, exposed for tests and support. */
  downloadHref?: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  testId?: string;
}) {
  return <DenButton type="button" className="w-full" onClick={onClick} disabled={disabled} loading={loading} data-testid={testId} data-download-href={downloadHref}>{children}</DenButton>;
}

export function JoinQuietButton({ children, onClick, disabled, testId }: { children: ReactNode; onClick: () => void; disabled?: boolean; testId?: string }) {
  return <SetupQuietButton className="self-center rounded-md px-2 py-1" onClick={onClick} disabled={disabled} data-testid={testId}>{children}</SetupQuietButton>;
}

export function JoinAlert({ children }: { children: ReactNode }) {
  return <SetupErrorLine>{children}</SetupErrorLine>;
}

export function JoinLoadingBar() {
  return (
    <div className="grid gap-2" aria-hidden="true">
      <span className="h-3 w-40 rounded-md bg-[#f0f0f0] motion-safe:animate-pulse" />
      <span className="h-3 w-56 rounded-md bg-[#f0f0f0] motion-safe:animate-pulse" />
    </div>
  );
}
