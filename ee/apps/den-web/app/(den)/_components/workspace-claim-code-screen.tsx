"use client";

import Link from "next/link";
import { Check, Flag, Folder, Terminal } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { getErrorMessage, requestJson } from "../_lib/den-flow";
import { getOrgDashboardRoute } from "../_lib/den-org";
import { useDenFlow } from "../_providers/den-flow-provider";
import { AuthPanel } from "./auth-panel";
import { OnboardingTexture } from "./onboarding-texture";
import { SetupFrame } from "./setup-frame";
import {
  SetupCode,
  SetupErrorLine,
  SetupFacts,
  SetupLetterTile,
  SetupLine,
  SetupPanelBody,
  SetupPanelTitle,
  SetupQuietButton,
  SetupSkeletonRows,
  SetupStatus,
  SetupStoryTile,
  SetupStoryTiles,
} from "./setup-frame-parts";

type CodeState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "pending"; organizationName: string }
  | { kind: "invalid"; message: string }
  | { kind: "claimed"; organizationName: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readOrganizationName(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.organization)) return null;
  return typeof payload.organization.name === "string" ? payload.organization.name : null;
}

/** Display form of a user code: ABCD-EFGH. */
function formatUserCode(value: string): string {
  const clean = value.replace(/[\s-]/g, "").toUpperCase();
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

/**
 * The person's half of "provision now, claim later": an agent already built
 * this workspace and handed over a code; signing in and confirming makes the
 * person its owner and ends the agent's temporary access.
 */
export function WorkspaceClaimCodeScreen({ initialUserCode }: { initialUserCode: string }) {
  const { user, sessionHydrated, signOut } = useDenFlow();
  const [userCode, setUserCode] = useState(formatUserCode(initialUserCode));
  const [draftCode, setDraftCode] = useState("");
  const [codeState, setCodeState] = useState<CodeState>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user || !userCode) return;
    let cancelled = false;
    setCodeState({ kind: "checking" });
    void (async () => {
      const { response, payload } = await requestJson(`/v1/bootstrap/claim-codes/${encodeURIComponent(userCode.replace(/-/g, ""))}`, { method: "GET" }, 12000);
      if (cancelled) return;
      if (!response.ok) {
        setCodeState({ kind: "invalid", message: "This code is invalid or has expired. Ask your agent for a new one." });
        return;
      }
      setCodeState({ kind: "pending", organizationName: readOrganizationName(payload) ?? "this workspace" });
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, userCode]);

  async function claim() {
    if (codeState.kind !== "pending") return;
    setBusy(true);
    setError(null);
    const { response, payload } = await requestJson(
      "/v1/bootstrap/claim-codes/accept",
      { method: "POST", body: JSON.stringify({ userCode: userCode.replace(/-/g, ""), mode: "new_org" }) },
      20000,
    );
    setBusy(false);
    if (!response.ok) {
      setError(getErrorMessage(payload, "Could not claim this workspace. Ask your agent for a new code."));
      return;
    }
    setCodeState({ kind: "claimed", organizationName: readOrganizationName(payload) ?? codeState.organizationName });
  }

  const workspaceName = codeState.kind === "pending" || codeState.kind === "claimed" ? codeState.organizationName : null;

  const frame = (children: ReactNode) => (
    <SetupFrame
      title="Claim your workspace."
      description={workspaceName ? `Your agent set up ${workspaceName} for you.` : "Your agent set up a workspace for you."}
      panelVisual={<OnboardingTexture />}
      aside={(
        <SetupStoryTiles
          linked={codeState.kind === "claimed"}
          from={{ label: "Your agent", mark: <SetupStoryTile><Terminal className="size-6 text-[var(--dls-text-primary)]" strokeWidth={1.5} /></SetupStoryTile> }}
          to={workspaceName
            ? { label: workspaceName, mark: <SetupLetterTile name={workspaceName} size="lg" /> }
            : { label: "Your workspace", mark: <SetupStoryTile><Folder className="size-5 text-[var(--dls-text-secondary)]" strokeWidth={1.5} /></SetupStoryTile> }}
        />
      )}
    >
      <div data-testid="workspace-claim">{children}</div>
    </SetupFrame>
  );

  if (!sessionHydrated) {
    return frame(
      <SetupPanelBody>
        <SetupPanelTitle>Claim your workspace</SetupPanelTitle>
        <SetupSkeletonRows count={1} />
      </SetupPanelBody>,
    );
  }

  if (!user) {
    return frame(
      <SetupPanelBody>
        {userCode ? <SetupFacts rows={[{ label: "Code", value: <SetupCode code={userCode} testId="claim-user-code" /> }]} /> : null}
        <AuthPanel
          bare
          emailFirstFlow
          socialFirst
          socialProviders={["google"]}
          prefillKey={userCode}
          emailStepContent={{ title: "Sign in to OpenWork" }}
          agentContext={userCode ? { kind: "claim", userCode } : undefined}
        />
      </SetupPanelBody>,
    );
  }

  if (!userCode) {
    return frame(
      <form
        className="flex flex-col gap-[18px]"
        onSubmit={(event) => {
          event.preventDefault();
          if (draftCode.trim()) setUserCode(formatUserCode(draftCode));
        }}
      >
        <SetupPanelTitle>Enter the code from your agent</SetupPanelTitle>
        <label className="flex flex-col gap-2">
          <span className="den-label">Code</span>
          <input
            className="den-input font-mono uppercase tracking-[0.12em]"
            value={draftCode}
            onChange={(event) => setDraftCode(event.target.value)}
            placeholder="ABCD-EFGH"
            autoComplete="off"
            autoFocus
          />
        </label>
        <SetupFacts rows={[{ label: "Account", value: user.email }]} />
        <button type="submit" className="den-button-primary w-full" disabled={!draftCode.trim()}>Continue</button>
      </form>,
    );
  }

  if (codeState.kind === "claimed") {
    return frame(
      <SetupStatus icon={<Check className="size-5" strokeWidth={1.5} />} title={`${codeState.organizationName} is yours`}>
        <Link href={getOrgDashboardRoute()} className="den-button-primary px-6">Open workspace</Link>
      </SetupStatus>,
    );
  }

  if (codeState.kind === "invalid") {
    return frame(
      <SetupPanelBody gap="md">
        <SetupPanelTitle>This code can’t be used</SetupPanelTitle>
        <SetupLine>{codeState.message}</SetupLine>
        <button type="button" className="den-button-secondary self-start" onClick={() => { setUserCode(""); setCodeState({ kind: "idle" }); }}>
          Enter a different code
        </button>
      </SetupPanelBody>,
    );
  }

  const checking = codeState.kind !== "pending";
  const organizationName = codeState.kind === "pending" ? codeState.organizationName : "…";

  return frame(
    <SetupPanelBody>
      <span className="flex size-10 items-center justify-center rounded-full bg-[var(--dls-hover)] text-[var(--dls-text-primary)]" aria-hidden="true">
        <Flag className="size-5" strokeWidth={1.5} />
      </span>
      <SetupPanelTitle>{`Claim ${organizationName}?`}</SetupPanelTitle>
      <SetupFacts
        rows={[
          { label: "Code", value: <SetupCode code={userCode} testId="claim-user-code" /> },
          { label: "Owner", value: user.email },
          { label: "Keep as", value: "A new organization" },
        ]}
      />
      <p className="m-0 text-[13px] leading-5 text-[var(--setup-ink-soft)]" data-testid="claim-consent-line">
        You become the owner of {organizationName} and everything your agent added to it. The agent’s temporary access ends now.
      </p>
      <div className="flex flex-col gap-3.5">
        {error ? <SetupErrorLine>{error}</SetupErrorLine> : null}
        <button type="button" className="den-button-primary w-full" onClick={() => void claim()} disabled={checking || busy}>
          {busy ? "Claiming…" : "Claim workspace"}
        </button>
        <SetupQuietButton className="self-start" onClick={() => void signOut()} disabled={busy}>
          Use a different account
        </SetupQuietButton>
      </div>
    </SetupPanelBody>,
  );
}
