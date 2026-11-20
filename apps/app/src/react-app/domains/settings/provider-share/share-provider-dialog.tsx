import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DenReauthNotice } from "../../cloud/den-reauth-notice";
import { ProviderTile } from "../pages/provider-rows";
import { shareConsentFacts, shareFailureMessage, shareNeedsReview, shareNeedsVerification, shareOutcomeFacts, shareOutcomeTitle, type SharedProviderArrival } from "./device-provider-share";

export type ShareProviderDialogProps = {
  /** The provider on this device being shared; null keeps the dialog closed. */
  provider: { id: string; name: string } | null;
  organizationName: string;
  /** Den already said a recent sign-in comes first. */
  verificationRequired: boolean;
  /** Shares it; `verifiedToken` is the newer sign-in after "Confirm it's you". Rejects with the server's error. */
  onShare: (providerId: string, verifiedToken?: string) => Promise<unknown>;
  onShared: (provider: { id: string; name: string }) => void;
  onClose: () => void;
  /**
   * The guided ending: after Den accepts the share the dialog stays open,
   * confirms the provider is listed under the organization on this device,
   * and asks which copy this device keeps. Absent, the dialog closes on accept.
   */
  guided?: {
    /** Refreshes this device and answers whether the shared provider is listed here. Safe to call again. */
    confirmArrival: (providerId: string) => Promise<SharedProviderArrival>;
    /** Removes the person's own key from this device; rejects with a sentence to show. */
    useOrganizationCopy: (provider: { id: string; name: string }, arrival: SharedProviderArrival) => Promise<void>;
    /** The dialog closed after a share; `kept` says whether the person's key is still on this device. */
    onFinished: (provider: { id: string; name: string }, result: { arrival: SharedProviderArrival; kept: boolean }) => void;
  };
};

function FactRows({ facts }: { facts: ReadonlyArray<{ label: string; value: string }> }) {
  return (
    <dl className="divide-y divide-border rounded-xl border border-border">
      {facts.map((fact) => (
        <div key={fact.label} className="flex gap-4 px-3 py-2.5">
          <dt className="w-28 shrink-0 text-muted-foreground">{fact.label}</dt>
          <dd className="min-w-0 flex-1 text-foreground">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The one confirmation before a key saved on this device goes to the
 * organization (DESIGN P9): who can use it, where the key goes, who pays and
 * how to undo it, as rows rather than prose (P6). Sharing is external and
 * hard to take back, so it confirms (P8).
 */
export function ShareProviderDialog(props: ShareProviderDialogProps) {
  const { provider } = props;
  const [pending, setPending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  // Set once Den accepted the share: the dialog now reports where it is.
  const [arrival, setArrival] = useState<SharedProviderArrival | null>(null);
  const [checking, setChecking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const submitting = useRef(false);
  // A verified sign-in replaces this device's session when the dialog closes,
  // so the settings page does not reload under a share that is still running.
  const commitSession = useRef<(() => void) | null>(null);
  const verifiedToken = useRef<string | null>(null);

  const finish = (kept = true) => {
    const finished = provider && arrival ? { provider, arrival } : null;
    setVerifying(false);
    setError(null);
    setUnconfirmed(false);
    setArrival(null);
    const commit = commitSession.current;
    commitSession.current = null;
    verifiedToken.current = null;
    props.onClose();
    commit?.();
    if (finished) props.guided?.onFinished(finished.provider, { arrival: finished.arrival, kept });
  };
  const close = () => { if (!pending && !removing) finish(); };

  const confirmArrival = async (providerId: string): Promise<SharedProviderArrival> =>
    props.guided ? props.guided.confirmArrival(providerId).catch((): SharedProviderArrival => ({ status: "pending" })) : { status: "pending" };

  const checkAgain = async () => {
    if (!provider || checking) return;
    setChecking(true);
    setArrival(await confirmArrival(provider.id));
    setChecking(false);
  };

  const useOrganizationCopy = async () => {
    if (!provider || !arrival || !props.guided || removing) return;
    setRemoving(true);
    setError(null);
    try {
      await props.guided.useOrganizationCopy(provider, arrival);
      setRemoving(false);
      finish(false);
    } catch (cause) {
      setRemoving(false);
      setError(cause instanceof Error && cause.message ? cause.message : "Could not remove your key from this device. It is still here.");
    }
  };

  const share = async () => {
    if (!provider || submitting.current || unconfirmed) return;
    submitting.current = true;
    const token = verifiedToken.current ?? undefined;
    setPending(true);
    setError(null);
    try {
      await props.onShare(provider.id, token);
      if (props.guided) {
        // The button stays busy until this device has an answer: the next
        // thing shown is the result, not a step of getting there (DESIGN P11).
        const next = await confirmArrival(provider.id);
        setPending(false);
        setVerifying(false);
        props.onShared(provider);
        setArrival(next);
        return;
      }
      setPending(false);
      props.onShared(provider);
      finish();
    } catch (cause) {
      setPending(false);
      // Den asks once; after a fresh verification a refusal is a real failure.
      if (!token && shareNeedsVerification(cause)) setVerifying(true);
      else {
        setVerifying(false);
        setError(shareFailureMessage(cause));
        if (shareNeedsReview(cause)) setUnconfirmed(true);
      }
    } finally {
      submitting.current = false;
    }
  };

  const organization = props.organizationName;
  if (provider && arrival) {
    const outcome = { providerName: provider.name, organizationName: organization, arrival };
    return (
      <Dialog open onOpenChange={(next) => { if (!next) close(); }}>
        <DialogContent data-testid="share-provider-dialog" data-step={arrival.status} className="max-h-[90dvh] overflow-y-auto" showCloseButton={!removing}>
          <DialogHeader className="flex-row items-center gap-3">
            <ProviderTile providerId={provider.id} name={provider.name} />
            <DialogTitle className="leading-snug">{shareOutcomeTitle(outcome)}</DialogTitle>
          </DialogHeader>
          <FactRows facts={shareOutcomeFacts(outcome)} />
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          {arrival.status === "arrived" ? (
            <DialogFooter>
              <Button variant="outline" data-testid="share-provider-keep-both" disabled={removing} onClick={() => finish()}>Keep both</Button>
              <Button data-testid="share-provider-use-organization" disabled={removing} aria-busy={removing} onClick={() => void useOrganizationCopy()}>
                {removing ? "Removing your key…" : `Use ${organization}'s copy`}
              </Button>
            </DialogFooter>
          ) : (
            <DialogFooter>
              <Button variant="outline" disabled={checking} onClick={() => finish()}>Done</Button>
              <Button data-testid="share-provider-check-again" disabled={checking} aria-busy={checking} onClick={() => void checkAgain()}>
                {checking ? "Checking…" : "Check again"}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Dialog open={provider !== null} onOpenChange={(next) => { if (!next) close(); }}>
      {provider ? (
        <DialogContent data-testid="share-provider-dialog" className="max-h-[90dvh] overflow-y-auto" showCloseButton={!pending}>
          <DialogHeader className="flex-row items-center gap-3">
            <ProviderTile providerId={provider.id} name={provider.name} />
            <DialogTitle className="leading-snug">Share {provider.name} with {organization}?</DialogTitle>
          </DialogHeader>
          <FactRows facts={shareConsentFacts({ providerName: provider.name, organizationName: organization, guided: Boolean(props.guided) })} />
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          {verifying ? (
            <DenReauthNotice
              title={`Confirm it's you to share ${provider.name}`}
              description="Verify in your browser, then return here. Nothing is shared until you do."
              onCancel={() => { setVerifying(false); setError(null); }}
              onVerified={async (_client, commit, token) => {
                commitSession.current = commit;
                verifiedToken.current = token;
                await share();
              }}
            />
          ) : (
            <DialogFooter>
              <Button variant="outline" disabled={pending} onClick={close}>Cancel</Button>
              <Button
                data-testid="share-provider-confirm"
                disabled={pending || unconfirmed}
                aria-busy={pending}
                onClick={() => { if (props.verificationRequired && !verifiedToken.current) setVerifying(true); else void share(); }}
              >
                {pending ? "Sharing…" : `Share with ${organization}`}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
