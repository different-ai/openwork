"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DenButton } from "../../_components/ui/button";
import { getRequestError, requestJson } from "../../_lib/den-flow";
import { getOrgAccessFlags, getWebRoute } from "../../_lib/den-org";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useDenFlow } from "../../_providers/den-flow-provider";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

type CloudTrial = {
  status: "eligible" | "active" | "expired" | "ineligible";
  startedAt: string | null;
  expiresAt: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDate(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function parseTrial(payload: unknown): CloudTrial | null {
  if (!isRecord(payload) || !isRecord(payload.trial)) return null;
  const trial = payload.trial;
  if ((trial.status !== "eligible" && trial.status !== "active" && trial.status !== "expired" && trial.status !== "ineligible")
    || !isDate(trial.startedAt) || !isDate(trial.expiresAt)
    || (trial.status === "active" && trial.expiresAt === null)) return null;
  return { status: trial.status, startedAt: trial.startedAt, expiresAt: trial.expiresAt };
}

type CloudTrialCardProps = {
  dismissible?: boolean;
  paidPlanHref?: string;
  onAccessChange?: (orgId: string, reason: "started" | "expired") => void;
};

/** Scope both the query cache and local interaction state to the selected organization. */
export function CloudTrialCard(props: CloudTrialCardProps) {
  const { orgId, orgSlug, orgContext } = useOrgDashboard();
  const { user } = useDenFlow();
  if (!user || !orgId || orgContext?.organization.id !== orgId || !orgContext.capabilities.openworkWeb) return null;
  const access = getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.roles);
  return <ScopedCloudTrialCard key={`${orgId}:${user.id}`} {...props} userId={user.id} orgId={orgId} orgSlug={orgSlug} canStart={access.isAdmin} />;
}

function ScopedCloudTrialCard({ orgId, userId, orgSlug, canStart, dismissible = false, paidPlanHref, onAccessChange }: CloudTrialCardProps & {
  orgId: string;
  userId: string;
  orgSlug: string | null;
  canStart: boolean;
}) {
  const { runReauthableAction } = useOrgDashboard();
  const { runtimeConfig } = useDenFlow();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const alive = useRef(true);
  const starting = useRef(false);
  const expiryNotified = useRef(false);
  const activeNotified = useRef(false);
  const onAccessChangeRef = useRef(onAccessChange);
  onAccessChangeRef.current = onAccessChange;
  const queryKey = ["cloud-trial", orgId, userId];
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const { response, payload } = await requestJson("/v1/billing/web-trial", {
        method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId },
      }, 12000);
      if (!response.ok) throw getRequestError(payload, response, "Could not check cloud trial availability.");
      const parsed = parseTrial(payload);
      if (!parsed) throw new Error("Cloud trial details were incomplete. Try again.");
      return parsed;
    },
    staleTime: 30_000,
    retry: false,
  });
  const trial = query.data;
  const expiresAt = trial?.expiresAt ? Date.parse(trial.expiresAt) : null;
  const expired = trial?.status === "expired" || (trial?.status === "active" && expiresAt !== null && expiresAt <= now);
  const daysRemaining = expiresAt === null ? 0 : Math.max(0, Math.ceil((expiresAt - now) / 86_400_000));
  const endingSoon = trial?.status === "active" && expiresAt !== null && expiresAt - now <= 86_400_000;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (trial?.status !== "active" || expired || activeNotified.current) return;
    activeNotified.current = true;
    onAccessChangeRef.current?.(orgId, "started");
  }, [trial?.status, expired, orgId]);

  useEffect(() => {
    if (trial?.status !== "ineligible" || !activeNotified.current) return;
    activeNotified.current = false;
    onAccessChangeRef.current?.(orgId, "started");
  }, [trial?.status, orgId]);

  useEffect(() => {
    if (!expired || expiryNotified.current) return;
    expiryNotified.current = true;
    onAccessChangeRef.current?.(orgId, "expired");
  }, [expired, orgId]);

  useEffect(() => {
    if (trial?.status !== "active" || expiresAt === null) return;
    let timer: number | null = null;
    const update = () => {
      if (timer !== null) window.clearTimeout(timer);
      const currentTime = Date.now();
      setNow(currentTime);
      if (currentTime >= expiresAt) {
        void query.refetch();
        return;
      }
      const untilExpiry = expiresAt - currentTime;
      const nextUpdate = Math.min(untilExpiry, untilExpiry % 86_400_000 || 86_400_000);
      timer = window.setTimeout(update, Math.min(nextUpdate + 50, 2_147_483_647));
    };
    update();
    window.addEventListener("focus", update);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("focus", update);
    };
  }, [trial?.status, expiresAt, query.refetch]);

  async function startTrial() {
    if (!canStart || starting.current || trial?.status !== "eligible") return;
    starting.current = true;
    setBusy(true);
    setError(null);
    try {
      await runReauthableAction("start-cloud-trial", async () => {
        if (!alive.current) throw new Error("Your workspace changed. Review the trial before starting it.");
        const { response, payload } = await requestJson("/v1/billing/web-trial", {
          method: "POST", headers: { [ORG_SCOPE_HEADER]: orgId },
        }, 12000);
        if (!response.ok) throw getRequestError(payload, response, "Could not start the cloud trial. Try again.");
        const parsed = parseTrial(payload);
        if (!parsed || parsed.status !== "active") throw new Error("The cloud trial could not be confirmed. Check its status before trying again.");
        queryClient.setQueryData(queryKey, parsed);
        if (alive.current) {
          setNow(Date.now());
        }
      });
    } catch (error) {
      if (alive.current) {
        setError(error instanceof Error ? error.message : "Could not start the cloud trial.");
        // A lost response may still have started the trial. Reconcile before another attempt.
        void query.refetch();
      }
    } finally {
      starting.current = false;
      if (alive.current) setBusy(false);
    }
  }

  if (dismissed || trial?.status === "ineligible") return null;
  const status = expired ? "expired" : trial?.status ?? "loading";
  return (
    <section className="my-6 rounded-2xl bg-neutral-50 ring-1 ring-inset ring-neutral-200/60 p-5 sm:p-6" data-testid="cloud-trial-card" data-trial-status={status} aria-busy={busy}>
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white"><img src="/openwork-mark.svg" alt="" className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold tracking-tight text-neutral-950">
            {expired ? "Your cloud trial has ended" : trial?.status === "active" ? endingSoon ? "Your cloud trial ends soon" : "Your cloud trial is active" : "Try OpenWork Cloud for 7 days"}
          </h2>
          {!trial && query.isPending ? <p className="mt-2 text-sm text-neutral-500" role="status">Checking trial availability…</p> : null}
          {trial?.status === "eligible" ? <>
            <p className="mt-2 text-sm leading-6 text-neutral-600">No card required. Cloud access ends after 7 days unless you choose a paid plan. You won’t be charged automatically.</p>
            <p className="mt-2 text-xs leading-5 text-neutral-500">Cloud access only. Model-provider setup and charges are separate.</p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {canStart ? <DenButton data-testid="cloud-trial-start" disabled={busy || query.isFetching} loading={busy} onClick={() => void startTrial()}>Start 7-day free trial</DenButton>
                : <p className="text-sm text-neutral-500">Ask an owner or admin to start the trial.</p>}
              {dismissible ? <DenButton variant="ghost" data-testid="cloud-trial-dismiss" disabled={busy} onClick={() => setDismissed(true)}>Do this later</DenButton> : null}
            </div>
          </> : null}
          {trial?.status === "active" && !expired ? <>
            <p className="mt-2 text-sm leading-6 text-neutral-600" role="status">Cloud access ends {trial.expiresAt ? <time dateTime={trial.expiresAt}>{new Date(trial.expiresAt).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</time> : null}. No automatic charge.</p>
            <p className="mt-2 text-xs leading-5 text-neutral-500">{daysRemaining === 1 ? "Less than a day remaining." : `${daysRemaining} days remaining.`} Model-provider setup and charges are separate.</p>
            <p className="mt-2 text-xs leading-5 text-neutral-500">We’ll email the person who started the trial before it ends and when cloud access pauses.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <DenButton href={runtimeConfig.openworkWebUrl} target="_blank" rel="noopener noreferrer">Open OpenWork Web</DenButton>
              <DenButton variant="secondary" href={paidPlanHref ?? getWebRoute(orgSlug)}>View paid plan</DenButton>
            </div>
          </> : null}
          {expired ? <>
            <p className="mt-2 text-sm leading-6 text-neutral-600">New cloud work is paused. Your saved work stays in your workspace. Choose a paid plan to resume cloud work. You won’t be charged automatically.</p>
            <DenButton className="mt-4" href={paidPlanHref ?? getWebRoute(orgSlug)}>View paid plan</DenButton>
            <p className="mt-3 text-xs leading-5 text-neutral-500">You can still use OpenWork Desktop for local work. Your saved cloud work stays in your cloud workspace.</p>
          </> : null}
          {error || query.isError ? <div className="mt-3" role="alert">
            <p className="text-sm text-red-700">{error ?? (query.error instanceof Error ? query.error.message : "Could not check trial availability.")}</p>
            <DenButton className="mt-2" variant="ghost" size="sm" disabled={busy || query.isFetching} onClick={() => { setError(null); void query.refetch(); }}>Check trial status</DenButton>
          </div> : null}
        </div>
      </div>
    </section>
  );
}
