import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DenReauthNotice } from "../../cloud/den-reauth-notice";
import { ProviderTile } from "../pages/provider-rows";
import { shareConsentFacts, shareFailureMessage, shareNeedsReview, shareNeedsVerification } from "./device-provider-share";

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
};

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
  const submitting = useRef(false);
  // A verified sign-in replaces this device's session when the dialog closes,
  // so the settings page does not reload under a share that is still running.
  const commitSession = useRef<(() => void) | null>(null);
  const verifiedToken = useRef<string | null>(null);

  const finish = () => {
    setVerifying(false);
    setError(null);
    setUnconfirmed(false);
    const commit = commitSession.current;
    commitSession.current = null;
    verifiedToken.current = null;
    props.onClose();
    commit?.();
  };
  const close = () => { if (!pending) finish(); };

  const share = async () => {
    if (!provider || submitting.current || unconfirmed) return;
    submitting.current = true;
    const token = verifiedToken.current ?? undefined;
    setPending(true);
    setError(null);
    try {
      await props.onShare(provider.id, token);
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
  return (
    <Dialog open={provider !== null} onOpenChange={(next) => { if (!next) close(); }}>
      {provider ? (
        <DialogContent data-testid="share-provider-dialog" className="max-h-[90dvh] overflow-y-auto" showCloseButton={!pending}>
          <DialogHeader className="flex-row items-center gap-3">
            <ProviderTile providerId={provider.id} name={provider.name} />
            <DialogTitle className="leading-snug">Share {provider.name} with {organization}?</DialogTitle>
          </DialogHeader>
          <dl className="divide-y divide-border rounded-xl border border-border">
            {shareConsentFacts({ providerName: provider.name, organizationName: organization }).map((fact) => (
              <div key={fact.label} className="flex gap-4 px-3 py-2.5">
                <dt className="w-28 shrink-0 text-muted-foreground">{fact.label}</dt>
                <dd className="min-w-0 flex-1 text-foreground">{fact.value}</dd>
              </div>
            ))}
          </dl>
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
