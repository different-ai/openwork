"use client";

import { Check, Terminal, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getErrorMessage, requestJson } from "../_lib/den-flow";
import { useDenFlow } from "../_providers/den-flow-provider";
import { AuthPanel } from "./auth-panel";
import { DenButton } from "./ui/button";
import { DenInput } from "./ui/input";
import { DenNotice } from "./ui/notice";
import { DenSelect } from "./ui/select";

type Organization = { id: string; name: string; isActive: boolean };

type CodeState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "pending" }
  | { kind: "invalid"; message: string }
  | { kind: "approved" }
  | { kind: "denied" };

const CLIENT_NAMES: Record<string, string> = {
  "openwork-cli": "OpenWork CLI",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseOrganizations(payload: unknown): Organization[] {
  if (!isRecord(payload) || !Array.isArray(payload.orgs)) return [];
  const orgs: Organization[] = [];
  for (const entry of payload.orgs) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    const name = typeof entry.name === "string" && entry.name.trim() ? entry.name : typeof entry.slug === "string" ? entry.slug : entry.id;
    orgs.push({ id: entry.id, name, isActive: entry.isActive === true });
  }
  return orgs;
}

/** Display form of a user code: ABCD-EFGH. */
function formatUserCode(value: string): string {
  const clean = value.replace(/[\s-]/g, "").toUpperCase();
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

function readStatus(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.status === "string" ? payload.status : null;
}

function readClientId(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.clientId === "string" ? payload.clientId : null;
}

export function DeviceApprovalScreen({ initialUserCode }: { initialUserCode: string }) {
  const { user, sessionHydrated, signOut } = useDenFlow();
  const [userCode, setUserCode] = useState(formatUserCode(initialUserCode));
  const [draftCode, setDraftCode] = useState("");
  const [codeState, setCodeState] = useState<CodeState>({ kind: "idle" });
  const [clientName, setClientName] = useState("OpenWork CLI");
  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  const [organizationId, setOrganizationId] = useState("");
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user || !userCode) return;
    let cancelled = false;
    setCodeState({ kind: "checking" });
    void (async () => {
      const [lookup, directory] = await Promise.all([
        requestJson(`/v1/auth/device/${encodeURIComponent(userCode.replace(/-/g, ""))}`, { method: "GET" }, 12000),
        requestJson("/v1/me/orgs", { method: "GET" }, 12000),
      ]);
      if (cancelled) return;
      const list = directory.response.ok ? parseOrganizations(directory.payload) : [];
      setOrgs(list);
      setOrganizationId(list.find((org) => org.isActive)?.id ?? list[0]?.id ?? "");
      if (!lookup.response.ok) {
        setCodeState({ kind: "invalid", message: getErrorMessage(lookup.payload, "This code is not valid. Check it against your terminal.") });
        return;
      }
      const clientId = readClientId(lookup.payload);
      if (clientId) setClientName(CLIENT_NAMES[clientId] ?? clientId);
      const status = readStatus(lookup.payload);
      setCodeState(status === "approved" ? { kind: "approved" } : status === "denied" ? { kind: "denied" } : { kind: "pending" });
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, userCode]);

  const selectedOrg = useMemo(() => orgs?.find((org) => org.id === organizationId) ?? null, [orgs, organizationId]);

  async function decide(decision: "approve" | "deny") {
    setBusy(decision);
    setError(null);
    const { response, payload } = await requestJson(
      "/v1/auth/device/decision",
      {
        method: "POST",
        body: JSON.stringify({
          userCode: userCode.replace(/-/g, ""),
          decision,
          ...(decision === "approve" && organizationId ? { organizationId } : {}),
        }),
      },
      12000,
    );
    setBusy(null);
    if (!response.ok) {
      setError(getErrorMessage(payload, "Could not record your choice. Start sign-in again from your terminal."));
      return;
    }
    setCodeState(decision === "approve" ? { kind: "approved" } : { kind: "denied" });
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
          <h1 className="den-title-lg text-center">Sign in to OpenWork CLI</h1>
          {userCode ? (
            <p className="text-center font-mono text-[20px] font-semibold tracking-[0.12em] text-[var(--dls-text-primary)]" data-testid="device-user-code">
              {userCode}
            </p>
          ) : null}
          <AuthPanel
            eyebrow="OpenWork CLI"
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
        <h1 className="den-title-lg">Enter the code from your terminal</h1>
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

  if (codeState.kind === "approved") {
    return frame(
      <div className="grid gap-3" role="status">
        <span className="flex size-10 items-center justify-center rounded-full bg-[var(--dls-hover)]">
          <Check className="size-5" aria-hidden />
        </span>
        <h1 className="den-title-lg">{clientName} is signed in</h1>
        <p className="den-copy">Return to your terminal. You can close this tab.</p>
      </div>,
    );
  }

  if (codeState.kind === "denied") {
    return frame(
      <div className="grid gap-3" role="status">
        <span className="flex size-10 items-center justify-center rounded-full bg-[var(--dls-hover)]">
          <X className="size-5" aria-hidden />
        </span>
        <h1 className="den-title-lg">Sign-in denied</h1>
        <p className="den-copy">{clientName} did not get access. You can close this tab.</p>
      </div>,
    );
  }

  if (codeState.kind === "invalid") {
    return frame(
      <div className="grid gap-4">
        <h1 className="den-title-lg">This code can&apos;t be used</h1>
        <DenNotice message={codeState.message} />
        <div>
          <DenButton variant="secondary" onClick={() => { setUserCode(""); setCodeState({ kind: "idle" }); }}>
            Enter a different code
          </DenButton>
        </div>
      </div>,
    );
  }

  const checking = codeState.kind === "checking" || codeState.kind === "idle" || orgs === null;
  const orgLabel = selectedOrg ? selectedOrg.name : "no organization yet";

  return frame(
    <>
      <div className="grid gap-4">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--dls-hover)]">
            <Terminal className="size-4" aria-hidden />
          </span>
          <h1 className="den-title-lg">Sign in {clientName}?</h1>
        </div>
        <div className="grid gap-1">
          <span className="den-label">Code</span>
          <span className="font-mono text-[20px] font-semibold tracking-[0.12em] text-[var(--dls-text-primary)]" data-testid="device-user-code">
            {userCode}
          </span>
        </div>
      </div>

      <div className="grid divide-y divide-[var(--dls-border)] border-y border-[var(--dls-border)]">
        <div className="flex min-h-11 items-center justify-between gap-4 py-2 text-[13px]">
          <span className="text-[var(--dls-text-secondary)]">Account</span>
          <span className="truncate font-medium text-[var(--dls-text-primary)]">{user.email}</span>
        </div>
        {orgs && orgs.length > 1 ? (
          <div className="flex min-h-11 items-center justify-between gap-4 py-2 text-[13px]">
            <span className="text-[var(--dls-text-secondary)]">Organization</span>
            <DenSelect aria-label="Organization" value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} disabled={busy !== null}>
              {orgs.map((org) => (
                <option key={org.id} value={org.id}>{org.name}</option>
              ))}
            </DenSelect>
          </div>
        ) : (
          <div className="flex min-h-11 items-center justify-between gap-4 py-2 text-[13px]">
            <span className="text-[var(--dls-text-secondary)]">Organization</span>
            <span className="font-medium text-[var(--dls-text-primary)]">{checking ? "…" : selectedOrg?.name ?? "None yet"}</span>
          </div>
        )}
      </div>

      <p className="den-copy text-[13px]" data-testid="device-consent-line">
        Only approve if you started this in your own terminal and the code matches. {clientName} will act as {user.email} in {orgLabel} until you sign out of it.
      </p>

      {error ? <DenNotice message={error} /> : null}

      <div className="flex flex-wrap items-center gap-3">
        <DenButton onClick={() => void decide("approve")} loading={busy === "approve"} disabled={checking || busy !== null}>
          Sign in {clientName}
        </DenButton>
        <DenButton variant="secondary" onClick={() => void decide("deny")} loading={busy === "deny"} disabled={checking || busy !== null}>
          Deny
        </DenButton>
        <DenButton variant="ghost" onClick={() => void signOut()} disabled={busy !== null}>
          Use a different account
        </DenButton>
      </div>
    </>,
  );
}
