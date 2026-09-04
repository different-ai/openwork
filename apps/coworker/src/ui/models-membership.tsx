import { useEffect, useState } from "react";
import { buildDenAccountUrl, DenError, readModelsMembership, type DenSession, type ModelsMembership } from "@/lib/den";
import { coworkerBridge } from "@/lib/bridge";
import { Button, ErrorNote } from "@/ui/kit";

type MembershipState =
  | { kind: "loading" }
  | { kind: "ready"; membership: ModelsMembership }
  | { kind: "admin" | "unavailable" };

const WINDOW_LABELS = { five_hour: "5-hour allowance", weekly: "Weekly allowance", monthly: "Monthly allowance" };

/** Read-only discovery of the existing membership. Purchase stays in Den's checkout. */
export function ModelsMembershipCard({ session, baseUrl, onConnect, onRefreshModels }: {
  session: DenSession | null;
  baseUrl: string;
  onConnect: () => void;
  onRefreshModels: () => Promise<unknown>;
}) {
  const [state, setState] = useState<MembershipState>({ kind: "loading" });
  const [revision, setRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    if (!session) return;
    void readModelsMembership(session).then(
      (membership) => { if (!cancelled) setState({ kind: "ready", membership }); },
      (cause: unknown) => { if (!cancelled) setState({ kind: cause instanceof DenError && cause.status === 403 ? "admin" : "unavailable" }); },
    );
    return () => { cancelled = true; };
  }, [session, revision]);

  // Returning from Den refreshes the entitlement. It never changes a chosen model.
  useEffect(() => {
    if (!session) return;
    let lastRefresh = Date.now();
    const onFocus = () => {
      if (Date.now() - lastRefresh < 15_000) return;
      lastRefresh = Date.now();
      setRevision((value) => value + 1);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [session]);

  async function open(destination: "models" | "billing") {
    setError("");
    try { await coworkerBridge.openExternal(buildDenAccountUrl(session?.baseUrl ?? baseUrl, destination)); }
    catch { setError("Couldn't open OpenWork in your browser. Try again."); }
  }
  async function refresh() {
    setRefreshing(true);
    setError("");
    setRevision((value) => value + 1);
    try { await onRefreshModels(); }
    catch { setError("Couldn't refresh your models. Your current model is unchanged; try again."); }
    finally { setRefreshing(false); }
  }

  const membership = session && state.kind === "ready" ? state.membership : null;
  const subscribed = membership?.subscribed === true;
  const now = Date.now();
  return (
    <section className="rounded-2xl border border-line bg-panel/45 p-5" data-testid="models-membership" data-state={!session ? "signed-out" : state.kind}>
      <h3 className="text-sm font-semibold text-snow">OpenWork Models</h3>
      <p className="mt-1 text-xs leading-5 text-mist">
        A separate monthly subscription for managed AI models. Keep your coworkers, conversations, and documents as you choose a model for the work.
      </p>
      {!session ? <p className="mt-3 text-xs text-mist">Sign in to check your membership, or compare the current models and pricing. Your own provider and the free model remain available.</p> : null}
      {session && state.kind === "loading" ? <p className="mt-3 text-xs text-mist" role="status">Checking membership…</p> : null}
      {session && state.kind === "admin" ? <p className="mt-3 text-xs text-mist">Your workspace admin manages the membership and shared usage. Models already available to you can still be used here.</p> : null}
      {session && state.kind === "unavailable" ? <p className="mt-3 text-xs text-mist">Membership status is unavailable. Check in OpenWork or refresh; this does not mean you need another subscription.</p> : null}
      {membership ? (
        <div className="mt-3" data-testid="models-membership-status">
          <p className="text-xs font-medium text-snow">{subscribed ? (membership.enabled && membership.upstreamProviderConfigured ? "Membership active" : "Membership active · setup needs attention") : "No active Models membership"}</p>
          {subscribed && (!membership.enabled || !membership.upstreamProviderConfigured) ? <p className="mt-1 text-xs text-mist">Open Models in OpenWork to finish setup, then refresh your models here.</p> : null}
          {subscribed ? <p className="mt-1 text-xs text-mist">Allowances are shared across {session?.orgName || "your workspace"}. Provider usage can take time to arrive.</p> : null}
          {subscribed ? membership.buckets.map((bucket) => {
            const current = Date.parse(bucket.windowStartAt) <= now && Date.parse(bucket.windowEndAt) > now;
            const left = Math.max(0, Math.min(100, bucket.limitAmount > 0 ? 100 * (1 - bucket.usedAmount / bucket.limitAmount) : 0));
            return <div key={bucket.windowType} className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-mist" data-testid={`models-usage-${bucket.windowType}`}>
              <span>{WINDOW_LABELS[bucket.windowType]}</span>
              <span>{current ? `${left.toFixed(0)}% left · resets ${new Date(bucket.windowEndAt).toLocaleString()}` : "Waiting for refreshed usage"}</span>
            </div>;
          }) : null}
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="primary" data-testid="models-membership-open" onClick={() => void open(subscribed && membership.enabled && membership.upstreamProviderConfigured ? "billing" : "models")}>
          {subscribed ? (membership.enabled && membership.upstreamProviderConfigured ? "Manage membership" : "Finish Models setup") : "View models & pricing"}
        </Button>
        {session ? <Button variant="ghost" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? "Refreshing…" : "Refresh membership & models"}</Button> : <Button variant="ghost" onClick={onConnect}>Sign in</Button>}
      </div>
      {session ? <p className="mt-2 text-[11px] leading-5 text-mist">In the browser, check that {session.orgName || "your workspace"} is selected. After subscribing, return here, refresh, and choose your model.</p> : null}
      {error ? <div className="mt-3"><ErrorNote>{error}</ErrorNote></div> : null}
    </section>
  );
}
