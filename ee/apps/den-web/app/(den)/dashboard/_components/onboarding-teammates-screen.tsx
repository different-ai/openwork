"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, LoaderCircle, Lock, Plus, X } from "lucide-react";
import { z } from "zod";
import { SetupFrame } from "../../_components/setup-frame";
import { DesktopHandoffAction } from "../../_components/auth-panel";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { getDesktopGrant } from "../../_lib/desktop-handoff";
import {
  freePlanUserLimitMessage,
  getOrgLimitError,
  getOrgPaymentRequiredError,
  getRequestError,
  normalizeAuthIntentParam,
  PENDING_AUTH_INTENT_STORAGE_KEY,
  requestJson,
  WORKSPACE_REAUTH_SECURITY_MESSAGE,
} from "../../_lib/den-flow";
import { getInferenceRoute, getOrgAccessFlags, getOrgDashboardRoute } from "../../_lib/den-org";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useDenFlow } from "../../_providers/den-flow-provider";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

type InvitationRow = {
  id: number;
  email: string;
  status: "draft" | "sending" | "sent" | "error";
  error: string | null;
};

const emailSchema = z.string().email();

export function OnboardingTeammatesScreen() {
  const { orgId, orgSlug, orgContext, orgError } = useOrgDashboard();
  const { user } = useDenFlow();
  if (!orgId || !orgContext || orgContext.organization.id !== orgId || !user) {
    return <SetupFrame step="people" title="Invite people." description="">
      <p role={orgError ? "alert" : "status"} className="text-sm text-neutral-500">{orgError ?? "Getting your workspace ready…"}</p>
    </SetupFrame>;
  }
  return <TeammatesForm key={`${orgId}:${user.id}`} orgId={orgId} orgSlug={orgSlug}
    organizationName={orgContext.organization.name} selfEmail={user.email}
    canInvite={getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions).canInviteMembers} />;
}

function TeammatesForm({ orgId, orgSlug, organizationName, selfEmail, canInvite }: {
  orgId: string;
  orgSlug: string | null;
  organizationName: string;
  selfEmail: string;
  canInvite: boolean;
}) {
  const router = useRouter();
  const { runReauthableAction, refreshOrgData } = useOrgDashboard();
  const { completeSetup, desktopAuthRequested, desktopRedirectUrl, authError } = useDenFlow();
  const [completing, setCompleting] = useState(false);
  const [completionError, setCompletionError] = useState<string | null>(null);
  const completingRef = useRef(false);
  const [rows, setRows] = useState<InvitationRow[]>([
    { id: 1, email: "", status: "draft", error: null },
    { id: 2, email: "", status: "draft", error: null },
  ]);
  const [sending, setSending] = useState(false);
  const [focusId, setFocusId] = useState<number | null>(null);
  const nextId = useRef(3);
  const sendingRef = useRef(false);
  const alive = useRef(true);
  const sentCount = rows.filter((row) => row.status === "sent").length;
  const pendingRows = rows.filter((row) => row.status !== "sent" && row.email.trim());
  const interactionBusy = sending || completing;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (focusId === null) return;
    document.getElementById(`teammate-email-${focusId}`)?.focus();
    setFocusId(null);
  }, [focusId]);

  useEffect(() => {
    if (!sending) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const preventLinkNavigation = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("a[href]")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", preventLinkNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", preventLinkNavigation, true);
    };
  }, [sending]);

  function updateRow(id: number, patch: Partial<InvitationRow>) {
    if (alive.current) setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  }

  async function sendInvitations() {
    if (sendingRef.current || completingRef.current || !canInvite || pendingRows.length === 0) return;
    const normalized = rows.map((row) => ({ ...row, email: row.email.trim().toLowerCase() }));
    const errors = new Map<number, string>();
    for (const row of normalized) {
      if (!row.email || row.status === "sent") continue;
      if (!emailSchema.safeParse(row.email).success) errors.set(row.id, "Enter a valid email address.");
      else if (row.email === selfEmail.trim().toLowerCase()) errors.set(row.id, "You’re already in this workspace.");
      else if (normalized.some((other) => other.id !== row.id && other.email === row.email)) errors.set(row.id, "Use a different email address for each person.");
    }
    if (errors.size) {
      setRows((current) => current.map((row) => errors.has(row.id)
        ? { ...row, status: "error", error: errors.get(row.id) ?? null }
        : row.status === "error" ? { ...row, status: "draft", error: null } : row));
      setFocusId(errors.keys().next().value ?? null);
      return;
    }
    sendingRef.current = true;
    setSending(true);
    try {
      for (const row of normalized.filter((entry) => entry.email && entry.status !== "sent")) {
        if (!alive.current) break;
        updateRow(row.id, { status: "sending", error: null });
        try {
          await runReauthableAction(`onboarding-invite-${row.id}`, async () => {
            if (!alive.current) throw new Error("Your workspace changed. Review the remaining invitations before sending again.");
            // Pin the organization even if a background account refresh changes
            // the ambient scope while a fresh sign-in is being confirmed.
            const { response, payload } = await requestJson("/v1/invitations", {
              method: "POST",
              headers: { [ORG_SCOPE_HEADER]: orgId },
              body: JSON.stringify({ email: row.email, role: "member" }),
            }, 12000);
            if (!response.ok) {
              // Inviting a 6th user on the Free plan: ask for the Team plan.
              const freePlanLimit = getOrgPaymentRequiredError(payload);
              if (freePlanLimit) throw new Error(freePlanUserLimitMessage(freePlanLimit.freeSeatCount));
              // A full Team or Enterprise plan set by OpenWork: the server says how many users it includes.
              const planLimit = getOrgLimitError(payload);
              if (planLimit) throw new Error(planLimit.message);
              throw getRequestError(payload, response, "Could not send this invitation. Try again.");
            }
          });
          updateRow(row.id, { email: row.email, status: "sent", error: null });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not send this invitation. Try again.";
          updateRow(row.id, { status: "error", error: message });
          if (message === WORKSPACE_REAUTH_SECURITY_MESSAGE) break;
        }
      }

    } finally {
      sendingRef.current = false;
      if (alive.current) setSending(false);
    }
  }

  async function continueSetup() {
    if (sendingRef.current || completingRef.current) return;
    completingRef.current = true;
    setCompleting(true);
    setCompletionError(null);
    try {
      const intent = normalizeAuthIntentParam(window.sessionStorage.getItem(PENDING_AUTH_INTENT_STORAGE_KEY));
      const completed = await completeSetup(orgId);
      if (!alive.current) return;
      if (!completed) {
        setCompletionError("Your workspace didn’t open. Try again.");
      } else if (!desktopAuthRequested) {
        router.push(intent === "models" ? getInferenceRoute(orgSlug) : getOrgDashboardRoute(orgSlug));
        void refreshOrgData();
      }
    } catch (error) {
      if (alive.current) setCompletionError(error instanceof Error ? error.message : "Your workspace didn’t open. Try again.");
    } finally {
      completingRef.current = false;
      if (alive.current) setCompleting(false);
    }
  }

  const removeRow = (id: number) => {
    setRows((current) => current.filter((entry) => entry.id !== id));
    setFocusId(rows.find((entry) => entry.id !== id && entry.status !== "sent")?.id ?? null);
  };
  const addRow = () => {
    const id = nextId.current++;
    setRows((current) => [...current, { id, email: "", status: "draft", error: null }]);
    setFocusId(id);
  };
  // Titles in this flow end with a period like the sign-up panel's; avoid "Inc.."
  const workspaceName = organizationName.trim().replace(/\.+$/, "");
  // One primary action (P7): Send while addresses wait, otherwise opening the workspace.
  const finishButton = <DenButton type="button" variant={pendingRows.length > 0 ? "secondary" : "primary"} loading={completing} disabled={sending} onClick={() => void continueSetup()}>
    {desktopAuthRequested ? "Complete and open the app" : sentCount > 0 ? "Open workspace" : "Skip and open workspace"}
  </DenButton>;
  const quietAction = "inline-flex items-center gap-1.5 justify-self-start rounded-md text-[13px] font-medium text-gray-500 transition-colors hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-60";
  return <SetupFrame step="people" title={`Invite people to ${workspaceName}.`} description="">
    <div data-testid="onboarding-teammates" aria-busy={interactionBusy} className="grid gap-5">
      {authError || completionError ? <p role="alert" className="m-0 text-[13px] text-red-600">{authError || completionError}</p> : null}
      {desktopRedirectUrl ? <DesktopHandoffAction openworkUrl={desktopRedirectUrl} grant={getDesktopGrant(desktopRedirectUrl)} organizationName={organizationName} showCopyLinkByDefault /> : canInvite ? (
        <form noValidate className="grid gap-5" onSubmit={(event) => { event.preventDefault(); void sendInvitations(); }}>
          <div className="grid gap-3">
            {rows.map((row, index) => {
              const removable = rows.length > 1 && row.status !== "sent" && row.status !== "sending";
              return <div key={row.id} data-testid={`onboarding-invite-row-${index + 1}`} className="grid gap-1.5">
                <div className="relative">
                  <DenInput id={`teammate-email-${row.id}`} aria-label={`Teammate email ${index + 1}`} type="email" autoComplete="off" autoCapitalize="none" spellCheck={false}
                    placeholder={index === 0 ? "teammate@company.com" : "another@company.com"} value={row.email}
                    disabled={interactionBusy || row.status === "sent"} aria-invalid={row.status === "error"} aria-describedby={row.error ? `teammate-error-${row.id}` : undefined}
                    onChange={(event) => updateRow(row.id, { email: event.target.value, status: "draft", error: null })}
                    className={`pr-11 ${row.status === "error" ? "border-red-300" : ""}`} />
                  {/* One trailing slot per row: spinner, sent check, or remove. */}
                  <span className="absolute inset-y-0 right-1.5 flex items-center">
                    {row.status === "sending" ? <LoaderCircle aria-hidden className="mx-1.5 size-4 animate-spin text-gray-500 motion-reduce:animate-none" />
                      : row.status === "sent" ? <Check aria-hidden className="mx-1.5 size-4 text-gray-700" />
                      : removable ? <button type="button" aria-label={`Remove teammate ${index + 1}`} disabled={interactionBusy} onClick={() => removeRow(row.id)}
                        className="flex size-7 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 disabled:opacity-60"><X aria-hidden className="size-4" /></button>
                      : null}
                  </span>
                </div>
                {row.error ? <p id={`teammate-error-${row.id}`} role="alert" className="m-0 text-xs leading-5 text-red-600">{row.error}</p> : null}
                {row.status === "sending" || row.status === "sent" ? <p role="status" className="m-0 text-xs leading-5 text-gray-500">{row.status === "sent" ? "Invitation sent" : "Sending invitation…"}</p> : null}
              </div>;
            })}
            {rows.length < 5 ? <button type="button" disabled={interactionBusy} onClick={addRow} className={quietAction}>
              <Plus aria-hidden className="size-4" />Add another person
            </button> : null}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-gray-100 pt-5">
            {finishButton}
            {pendingRows.length > 0 ? <DenButton type="submit" loading={sending} disabled={completing}>Send invitations</DenButton> : null}
          </div>
        </form>
      ) : <>
        <p className="m-0 flex items-center gap-2 text-[13px] text-gray-500"><Lock aria-hidden className="size-4 shrink-0" />Only owners and admins can invite people.</p>
        <div className="flex justify-end border-t border-gray-100 pt-5">{finishButton}</div>
      </>}
    </div>
  </SetupFrame>;
}
