"use client";

import Link from "next/link";
import { Building2, Check } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { getErrorMessage, requestJson } from "../_lib/den-flow";
import { getOrgDashboardRoute } from "../_lib/den-org";
import { useDenFlow } from "../_providers/den-flow-provider";
import { AuthPanel } from "./auth-panel";
import { buttonVariants, DenButton } from "./ui/button";
import { DenInput } from "./ui/input";
import { DenNotice } from "./ui/notice";

const HEADING = "text-[20px] font-semibold leading-tight tracking-[-0.01em] text-[var(--dls-text-primary)]";

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
        setCodeState({ kind: "invalid", message: getErrorMessage(payload, "This code is invalid or has expired. Ask your agent for a new one.") });
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

  const frame = (children: ReactNode) => (
    <section className="den-page py-6 lg:py-10">
      <div className="den-frame mx-auto grid w-full max-w-[32rem] gap-6 p-6 md:p-8">{children}</div>
    </section>
  );

  if (!sessionHydrated) {
    return frame(
      <div className="grid gap-3" aria-busy="true">
        <div className="h-6 w-2/3 animate-pulse rounded-md bg-[var(--dls-hover)]" />
        <div className="h-12 animate-pulse rounded-lg bg-[var(--dls-hover)]" />
        <div className="h-10 w-40 animate-pulse rounded-lg bg-[var(--dls-hover)]" />
      </div>,
    );
  }

  if (!user) {
    return (
      <section className="den-page py-6 lg:py-10">
        <div className="mx-auto grid w-full max-w-[32rem] gap-5">
          <h1 className={`${HEADING} text-center`}>Claim the workspace your agent set up</h1>
          {userCode ? (
            <p className="text-center font-mono text-[20px] font-semibold tracking-[0.12em] text-[var(--dls-text-primary)]" data-testid="claim-user-code">
              {userCode}
            </p>
          ) : null}
          <AuthPanel
            eyebrow="Workspace owner"
            prefillKey={userCode}
            // Social sign-in returns to the site root and would drop this code.
            hideSocialAuth
            signUpContent={{ title: "Create your account", submitLabel: "Create account" }}
            signInContent={{ title: "Sign in", submitLabel: "Sign in" }}
          />
        </div>
      </section>
    );
  }

  if (!userCode) {
    return frame(
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (draftCode.trim()) setUserCode(formatUserCode(draftCode));
        }}
      >
        <h1 className={HEADING}>Enter the code from your agent</h1>
        <DenInput
          aria-label="Code"
          value={draftCode}
          onChange={(event) => setDraftCode(event.target.value)}
          placeholder="ABCD-EFGH"
          autoComplete="off"
          className="font-mono uppercase tracking-[0.12em]"
        />
        <div>
          <DenButton type="submit" disabled={!draftCode.trim()}>Continue</DenButton>
        </div>
      </form>,
    );
  }

  if (codeState.kind === "claimed") {
    return frame(
      <div className="grid gap-4" role="status">
        <span className="flex size-10 items-center justify-center rounded-full bg-[var(--dls-hover)]">
          <Check className="size-5" aria-hidden />
        </span>
        <h1 className={HEADING}>{codeState.organizationName} is yours</h1>
        <div>
          <Link href={getOrgDashboardRoute()} className={buttonVariants()}>Open workspace</Link>
        </div>
      </div>,
    );
  }

  if (codeState.kind === "invalid") {
    return frame(
      <div className="grid gap-4">
        <h1 className={HEADING}>This code can&apos;t be used</h1>
        <DenNotice message={codeState.message} />
        <div>
          <DenButton variant="secondary" onClick={() => { setUserCode(""); setCodeState({ kind: "idle" }); }}>
            Enter a different code
          </DenButton>
        </div>
      </div>,
    );
  }

  const checking = codeState.kind !== "pending";
  const organizationName = codeState.kind === "pending" ? codeState.organizationName : "…";

  return frame(
    <>
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--dls-hover)]">
          <Building2 className="size-4" aria-hidden />
        </span>
        <h1 className={HEADING}>Claim {organizationName}?</h1>
      </div>

      <div className="grid divide-y divide-[var(--dls-border)] border-y border-[var(--dls-border)]">
        <div className="flex min-h-11 items-center justify-between gap-4 py-2 text-[13px]">
          <span className="text-[var(--dls-text-secondary)]">Code</span>
          <span className="font-mono font-semibold tracking-[0.12em] text-[var(--dls-text-primary)]" data-testid="claim-user-code">{userCode}</span>
        </div>
        <div className="flex min-h-11 items-center justify-between gap-4 py-2 text-[13px]">
          <span className="text-[var(--dls-text-secondary)]">Owner</span>
          <span className="truncate font-medium text-[var(--dls-text-primary)]">{user.email}</span>
        </div>
        <div className="flex min-h-11 items-center justify-between gap-4 py-2 text-[13px]">
          <span className="text-[var(--dls-text-secondary)]">Keep as</span>
          <span className="font-medium text-[var(--dls-text-primary)]">A new organization</span>
        </div>
      </div>

      <p className="den-copy text-[13px]" data-testid="claim-consent-line">
        You become the owner of {organizationName} and everything your agent added to it. The agent&apos;s temporary access ends now.
      </p>

      {error ? <DenNotice message={error} /> : null}

      <div className="flex flex-wrap items-center gap-3">
        <DenButton onClick={() => void claim()} loading={busy} disabled={checking || busy}>
          Claim workspace
        </DenButton>
        <DenButton variant="ghost" onClick={() => void signOut()} disabled={busy}>
          Use a different account
        </DenButton>
      </div>
    </>,
  );
}
