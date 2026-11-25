import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DenReauthNotice } from "../../cloud/den-reauth-notice";
import { ProviderTile } from "../pages/provider-rows";
import { shareConsentFacts, shareFailureMessage, shareNeedsReview, shareNeedsVerification, shareOutcomeFacts, shareOutcomeTitle, type SharedProviderArrival } from "./device-provider-share";

export type ShareProviderDialogProps = {
  provider: { id: string; name: string } | null;
  organizationName: string;
  verificationRequired: boolean;
  onShare: (providerId: string, verifiedToken?: string) => Promise<unknown>;
  onShared: (provider: { id: string; name: string }) => void;
  onClose: () => void;
  guided: {
    confirmArrival: (providerId: string) => Promise<SharedProviderArrival>;
    useOrganizationCopy: (provider: { id: string; name: string }, arrival: SharedProviderArrival) => Promise<void>;
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

export function ShareProviderDialog(props: ShareProviderDialogProps) {
  const { provider } = props;
  const [pending, setPending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [arrival, setArrival] = useState<SharedProviderArrival | null>(null);
  const [checking, setChecking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const submitting = useRef(false);
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
    if (finished) props.guided.onFinished(finished.provider, { arrival: finished.arrival, kept });
  };
  const close = () => { if (!pending && !removing) finish(); };

  const confirmArrival = async (providerId: string): Promise<SharedProviderArrival> =>
    props.guided.confirmArrival(providerId).catch((): SharedProviderArrival => ({ status: "pending" }));

  const checkAgain = async () => {
    if (!provider || checking) return;
    setChecking(true);
    setArrival(await confirmArrival(provider.id));
    setChecking(false);
  };

  const useOrganizationCopy = async () => {
    if (!provider || !arrival || removing) return;
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
      const next = await confirmArrival(provider.id);
      setPending(false);
      setVerifying(false);
      props.onShared(provider);
      setArrival(next);
    } catch (cause) {
      setPending(false);
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
          <FactRows facts={shareConsentFacts({ providerName: provider.name, organizationName: organization })} />
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
