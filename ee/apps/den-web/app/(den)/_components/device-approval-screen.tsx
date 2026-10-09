"use client";

import { Check, Terminal, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getErrorMessage, requestJson } from "../_lib/den-flow";
import { deviceReturnTarget, deviceReturnUrl } from "../_lib/device-return";
import { useDenFlow } from "../_providers/den-flow-provider";
import { AuthPanel } from "./auth-panel";
import { OnboardingTexture } from "./onboarding-texture";
import { SetupFrame } from "./setup-frame";
import {
  SetupCode,
  SetupErrorLine,
  SetupFacts,
  SetupLine,
  SetupPanelBody,
  SetupPanelTitle,
  SetupQuietButton,
  SetupSkeletonRows,
  SetupStatus,
  SetupTerminal,
  type SetupTerminalLine,
} from "./setup-frame-parts";
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
  "openwork-opencode-plugin": "OpenWork - OpenCode Plugin",
};

/** The command the person ran, echoed in the terminal illustration. */
const CLIENT_COMMANDS: Record<string, string> = {
  "openwork-cli": "openwork-bootstrap login",
  "openwork-opencode-plugin": "opencode auth login openwork",
};

/** Where the person goes back to once the code is decided. */
const CLIENT_RETURN_PLACES: Record<string, string> = {
  "openwork-opencode-plugin": "OpenCode",
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

export function DeviceApprovalScreen({ initialUserCode, returnTo = "" }: { initialUserCode: string; returnTo?: string }) {
  const { user, sessionHydrated, signOut } = useDenFlow();
  const [userCode, setUserCode] = useState(formatUserCode(initialUserCode));
  const [draftCode, setDraftCode] = useState("");
  const [codeState, setCodeState] = useState<CodeState>({ kind: "idle" });
  const [clientName, setClientName] = useState("OpenWork CLI");
  const [clientId, setClientId] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  const [organizationId, setOrganizationId] = useState("");
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState("");

  useEffect(() => {
    setHost(window.location.host);
  }, []);

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
        setCodeState({ kind: "invalid", message: "This code is not valid or has expired. Check it against your terminal, or run the command again." });
        return;
      }
      const clientId = readClientId(lookup.payload);
      setClientId(clientId);
      if (clientId) setClientName(CLIENT_NAMES[clientId] ?? clientId);
      const status = readStatus(lookup.payload);
      setCodeState(status === "approved" ? { kind: "approved" } : status === "denied" ? { kind: "denied" } : { kind: "pending" });
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, userCode]);

  const selectedOrg = useMemo(() => orgs?.find((org) => org.id === organizationId) ?? null, [orgs, organizationId]);
  // Only a known client may send the browser back, and only to a page on this machine.
  const returnUrl = useMemo(() => deviceReturnUrl(returnTo, clientId), [returnTo, clientId]);
  const command = (clientId && CLIENT_COMMANDS[clientId]) || "openwork-bootstrap login";
  const returnPlace = (clientId && CLIENT_RETURN_PLACES[clientId]) || "your terminal";

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
    // The person asked for this by deciding; the page they return to says what happened.
    if (returnUrl) window.location.assign(deviceReturnTarget(returnUrl, decision === "approve" ? "approved" : "denied"));
  }

  const shownCode = userCode || "XXXX-XXXX";
  const terminalStatus: SetupTerminalLine = codeState.kind === "approved"
    ? { text: `Signed in as ${user?.email ?? "you"}${selectedOrg ? ` in ${selectedOrg.name}` : ""}.` }
    : codeState.kind === "denied"
      ? { text: "Sign-in was denied." }
      : { text: "Waiting for approval...", muted: true };
  const description = codeState.kind === "approved"
    ? "Your terminal is signed in."
    : codeState.kind === "denied"
      ? "Your terminal did not get access."
      : "Your terminal is waiting for approval.";

  const frame = (children: ReactNode) => (
    <SetupFrame
      title={`Sign in ${clientName}.`}
      description={description}
      panelVisual={<OnboardingTexture />}
      aside={(
        <SetupTerminal
          lines={[
            { text: `$ ${command}` },
            { text: "Open this link to sign in:", muted: true },
            { text: `  ${host || "…"}/device` },
            { text: `and confirm the code ${shownCode}.`, muted: true },
            terminalStatus,
          ]}
        />
      )}
    >
      <div data-testid="device-approval">{children}</div>
    </SetupFrame>
  );

  if (!sessionHydrated) {
    return frame(
      <SetupPanelBody>
        <SetupPanelTitle>{`Sign in ${clientName}?`}</SetupPanelTitle>
        <SetupSkeletonRows count={1} />
      </SetupPanelBody>,
    );
  }

  if (!user) {
    return frame(
      <SetupPanelBody>
        {userCode ? <SetupFacts rows={[{ label: "Code", value: <SetupCode code={userCode} testId="device-user-code" /> }]} /> : null}
        <AuthPanel
          bare
          emailFirstFlow
          socialFirst
          socialProviders={["google"]}
          prefillKey={userCode}
          emailStepContent={{ title: "Sign in to OpenWork" }}
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
        <SetupPanelTitle>Enter the code from your terminal</SetupPanelTitle>
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

  if (codeState.kind === "approved") {
    return frame(<SetupStatus icon={<Check className="size-5" strokeWidth={1.5} />} title={`${clientName} is signed in`} line={`Return to ${returnPlace}.`} />);
  }

  if (codeState.kind === "denied") {
    return frame(<SetupStatus icon={<X className="size-5" strokeWidth={1.5} />} title="Sign-in denied" line={`${clientName} did not get access. You can close this tab.`} />);
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

  const checking = codeState.kind === "checking" || codeState.kind === "idle" || orgs === null;
  const orgLabel = selectedOrg ? selectedOrg.name : "no organization yet";

  return frame(
    <SetupPanelBody>
      <span className="flex size-10 items-center justify-center rounded-full bg-[var(--dls-hover)] text-[var(--dls-text-primary)]" aria-hidden="true">
        <Terminal className="size-5" strokeWidth={1.5} />
      </span>
      <SetupPanelTitle>{`Sign in ${clientName}?`}</SetupPanelTitle>
      <div className="flex flex-col gap-1">
        <span className="text-[13px] leading-[18px] text-[var(--dls-text-secondary)]">Code</span>
        <SetupCode code={userCode} size="lg" testId="device-user-code" />
      </div>
      <SetupFacts
        rows={[
          { label: "Account", value: user.email },
          {
            label: "Organization",
            value: orgs && orgs.length > 1 ? (
              <DenSelect aria-label="Organization" value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} disabled={busy !== null}>
                {orgs.map((org) => (
                  <option key={org.id} value={org.id}>{org.name}</option>
                ))}
              </DenSelect>
            ) : checking ? "…" : selectedOrg?.name ?? "None yet",
          },
        ]}
      />
      <p className="m-0 text-[13px] leading-5 text-[var(--setup-ink-soft)]" data-testid="device-consent-line">
        Only approve if you started this in your own terminal and the code matches. {clientName} will act as {user.email} in {orgLabel} until you sign out of it.
      </p>
      <div className="flex flex-col gap-3.5">
        {error ? <SetupErrorLine>{error}</SetupErrorLine> : null}
        <div className="flex gap-2.5">
          <button type="button" className="den-button-primary grow" onClick={() => void decide("approve")} disabled={checking || busy !== null}>
            {busy === "approve" ? "Signing in…" : `Sign in ${clientName}`}
          </button>
          <button type="button" className="den-button-secondary w-30 shrink-0" onClick={() => void decide("deny")} disabled={checking || busy !== null}>
            {busy === "deny" ? "Denying…" : "Deny"}
          </button>
        </div>
        <SetupQuietButton className="self-start" onClick={() => void signOut()} disabled={busy !== null}>
          Use a different account
        </SetupQuietButton>
      </div>
    </SetupPanelBody>,
  );
}
