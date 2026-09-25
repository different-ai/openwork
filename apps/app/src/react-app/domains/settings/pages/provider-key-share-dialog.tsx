import { useEffect, useRef, useState } from "react";
import type { OpenworkServerClient, ProviderKeyShareEligibility, ProviderKeyShareResult } from "@/app/lib/openwork-server";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProviderIcon } from "../../../design-system/provider-icon";
import type { ConnectedProvider } from "./ai-view";

export function ProviderKeyShareDialog({ provider, organizationId, client, onClose, onShared, onOpenDen }: {
  provider: ConnectedProvider;
  organizationId: string | null;
  client: OpenworkServerClient | null;
  onClose: () => void;
  onShared: (result: ProviderKeyShareResult) => void;
  onOpenDen: () => void;
}) {
  const [eligibility, setEligibility] = useState<ProviderKeyShareEligibility | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allMembers, setAllMembers] = useState(true);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [removeLocal, setRemoveLocal] = useState(true);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    let current = true;
    setEligibility(null);
    setError(null);
    setChecking(true);
    setTeamIds([]);
    if (!organizationId || !client) {
      setChecking(false);
      setError("Sign in to your organization on this desktop before sharing a device key.");
      return;
    }
    void client.providerKeyShareEligibility(provider.id, organizationId).then((value) => {
      if (current) setEligibility(value);
    }).catch((cause) => {
      if (current) setError(cause instanceof Error ? cause.message : "Sharing could not be verified. Your key stays on this device.");
    }).finally(() => { if (current) setChecking(false); });
    return () => { current = false; generation.current++; };
  }, [client, organizationId, provider.id, revision]);

  async function share() {
    if (!client || !eligibility?.eligible || eligibility.organizationId !== organizationId || busy || (!allMembers && !teamIds.length)) return;
    const requestGeneration = generation.current;
    setBusy(true);
    setError(null);
    try {
      const result = await client.shareProviderKey({ providerId: provider.id, organizationId, memberId: eligibility.memberId, allMembers, teamIds: allMembers ? [] : teamIds, removeLocal, confirmed: true });
      if (requestGeneration !== generation.current) return;
      onShared(result);
      onClose();
    } catch (cause) {
      if (requestGeneration === generation.current) setError(cause instanceof Error ? cause.message : "The transfer could not be confirmed. Your local key has not been removed.");
    } finally { if (requestGeneration === generation.current) setBusy(false); }
  }

  const organization = eligibility?.organizationName ?? "your organization";
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader><div className="flex items-center gap-3"><ProviderIcon providerId={provider.id} size={20} /><DialogTitle>Share {provider.name} with {organization}?</DialogTitle></div><DialogDescription>Your key becomes an organization credential, managed in Den.</DialogDescription></DialogHeader>
      {checking ? <div role="status" aria-label="Verifying administrator access" className="grid gap-3"><div className="h-12 animate-pulse rounded-md bg-muted" /><div className="h-24 animate-pulse rounded-md bg-muted" /></div> : null}
      {error ? <div role="alert" className="text-sm text-destructive">{error}</div> : null}
      {!checking && eligibility && !eligibility.eligible ? <p className="text-sm text-muted-foreground">{eligibility.reason || "Only a freshly verified organization administrator can share a device key."}</p> : null}
      {eligibility?.eligible ? <fieldset disabled={busy} className="grid gap-4">
        <dl className="grid gap-3 text-sm">
          <div><dt className="font-medium">Moves to Den</dt><dd className="text-muted-foreground">The key is stored server-side and served through the OpenWork Gateway. Upstream credentials never reach members’ devices.</dd></div>
          <div>
            <dt><label className="flex items-center gap-2 font-medium"><Checkbox checked={removeLocal} onCheckedChange={setRemoveLocal} />Leaves this device</label></dt>
            <dd className="text-muted-foreground">{removeLocal ? `Your local copy is removed once Den confirms the transfer. You keep using ${provider.name}, now as an organization provider.` : "A local copy stays on this device."}</dd>
          </div>
          <div><dt className="font-medium">Usage is billed to {organization}</dt><dd className="text-muted-foreground">Members you pick below can call it. You can change access or revoke it later in Den.</dd></div>
        </dl>
        <div className="grid gap-3 border-t border-border pt-4">
          <p className="text-sm font-medium">Who can access this</p>
          <div className="flex gap-2"><Button variant={allMembers ? "default" : "outline"} aria-pressed={allMembers} onClick={() => setAllMembers(true)}>Everyone</Button><Button variant={!allMembers ? "default" : "outline"} aria-pressed={!allMembers} onClick={() => setAllMembers(false)}>Choose teams</Button></div>
          {allMembers ? <p className="text-xs text-muted-foreground">Including members who join later.</p> : <div className="grid gap-3">{eligibility.teams.length ? eligibility.teams.map((team) => <label key={team.id} className="flex items-center gap-3 text-sm"><Checkbox checked={teamIds.includes(team.id)} onCheckedChange={(checked) => setTeamIds((current) => checked ? [...current, team.id] : current.filter((id) => id !== team.id))} />{team.name}</label>) : <p className="text-sm text-muted-foreground">No teams in this organization. Create teams in Den or choose Everyone.</p>}</div>}
          {!allMembers ? <p className="text-xs text-muted-foreground">Selected-team access may not include you.</p> : null}
        </div>
        <p className="text-xs text-muted-foreground">Administrator access verified for {organization}. Sharing checks it again; if Den cannot confirm the transfer, the key stays on this device.</p>
      </fieldset> : null}
      <DialogFooter className="sm:flex-wrap">
        <Button variant="ghost" className="sm:mr-auto" disabled={busy} onClick={onOpenDen}>Open in Den</Button>
        {!checking && !eligibility?.eligible ? <Button variant="outline" onClick={() => setRevision((value) => value + 1)}>Check again</Button> : null}
        <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button disabled={checking || busy || !eligibility?.eligible || (!allMembers && !teamIds.length)} onClick={() => void share()}>{busy ? "Sharing…" : "Share with organization"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
