import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCcw, Users } from "lucide-react";

import { DenApiError, formatDenOrgRoleLabel, isDenOrgAdminRole } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  SettingsInset,
  SettingsNotice,
  SettingsSection,
  SettingsSectionHeader,
  SettingsSectionHeaderContent,
  SettingsSectionHeaderDescription,
  SettingsSectionHeaderTitle,
} from "../settings-section";
import { useCloudSession } from "./cloud-session-provider";

type Props = {
  orgId: string;
  onConfirmSignIn: () => void;
};

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : "This action could not be completed. Please try again.";
}

export function TeamMembersSection({ orgId, onConfirmSignIn }: Props) {
  const { client, baseUrl, user } = useCloudSession();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [completion, setCompletion] = useState<string | null>(null);
  const queryKey = ["desktop-team", baseUrl, user?.id, orgId];
  const team = useQuery({ queryKey, queryFn: () => client.getTeam(orgId) });
  const invite = useMutation({
    mutationFn: (address: string) => client.inviteTeamMember(orgId, address),
    onSuccess: async (_, address) => {
      setEmail("");
      setCompletion(`Invitation sent to ${address}.`);
      await queryClient.invalidateQueries({ queryKey });
    },
    // An email delivery failure can still persist the invitation. Refresh the
    // list, but preserve the draft and error so retry never implies success.
    onError: () => queryClient.invalidateQueries({ queryKey }),
  });
  const cancel = useMutation({
    mutationFn: (invitationId: string) => client.cancelTeamInvitation(orgId, invitationId),
    onSuccess: async () => {
      setCompletion("Invitation cancelled.");
      await queryClient.invalidateQueries({ queryKey });
    },
  });
  const canInvite = team.data && (team.data.currentMember.isOwner || isDenOrgAdminRole(team.data.currentMember.role));
  const busy = invite.isPending || cancel.isPending;
  const error = invite.error ?? cancel.error;
  const needsSignIn = error instanceof DenApiError && error.code === "reauth";
  const members = team.data?.members.filter((member) => member.joinedAt !== null) ?? [];
  const invitations = team.data?.invitations.filter((invitation) => invitation.status === "pending") ?? [];

  return (
    <SettingsSection>
      <SettingsSectionHeader>
        <SettingsSectionHeaderContent>
          <SettingsSectionHeaderTitle><Users className="size-4" /> People</SettingsSectionHeaderTitle>
          <SettingsSectionHeaderDescription>
            {team.data?.organization.name ?? "Your organization"}. Manage invitations here; changes are saved to your team in Cloud.
          </SettingsSectionHeaderDescription>
        </SettingsSectionHeaderContent>
        <Button variant="outline" size="sm" disabled={team.isFetching || busy} onClick={() => void team.refetch()}>
          <RefreshCcw className="size-3.5" /> Refresh people
        </Button>
      </SettingsSectionHeader>

      {team.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading people…</p> : null}
      {team.error ? <SettingsNotice tone="error">{messageFor(team.error)}</SettingsNotice> : null}
      {team.data ? (
        <>
          {canInvite ? (
            <SettingsInset>
              <form className="flex flex-col gap-3" onSubmit={(event) => {
                event.preventDefault();
                if (busy || !email.trim()) return;
                setCompletion(null);
                cancel.reset();
                invite.mutate(email.trim());
              }}>
                <Field>
                  <FieldLabel htmlFor="team-invite-email">Invite a teammate</FieldLabel>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input id="team-invite-email" type="email" required autoComplete="email" placeholder="name@company.com"
                      value={email} disabled={busy} onChange={(event) => { setEmail(event.currentTarget.value); invite.reset(); setCompletion(null); }} />
                    <Button type="submit" disabled={busy || !email.trim()}>{invite.isPending ? "Sending invitation…" : "Send invitation"}</Button>
                  </div>
                  <FieldDescription>They’ll join as a member and receive your team’s assigned tools and desktop permissions.</FieldDescription>
                </Field>
              </form>
            </SettingsInset>
          ) : <p className="text-sm text-muted-foreground">An owner or admin can invite teammates. Your own account connections stay yours.</p>}

          {error ? (
            <SettingsNotice tone="error">
              <div role="alert" className="flex flex-col items-start gap-2">
                {messageFor(error)}
                {needsSignIn ? <Button variant="outline" size="sm" onClick={onConfirmSignIn}>Confirm sign-in</Button> : null}
              </div>
            </SettingsNotice>
          ) : null}
          {completion ? <p role="status" className="text-sm">{completion}</p> : null}

          <div className="divide-y rounded-xl border" data-testid="desktop-team-members">
            {members.map((member) => (
              <div key={member.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0"><p className="truncate text-sm font-medium">{member.user.name || member.user.email}</p><p className="truncate text-xs text-muted-foreground">{member.user.email}</p></div>
                <span className="shrink-0 text-xs text-muted-foreground">{member.isOwner ? "Owner" : formatDenOrgRoleLabel(member.role)}</span>
              </div>
            ))}
          </div>

          {invitations.length ? (
            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-medium">Pending invitations</h3>
              <div className="divide-y rounded-xl border" data-testid="desktop-team-invitations">
                {invitations.map((invitation) => (
                  <div key={invitation.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0"><p className="break-all text-sm">{invitation.email}</p><p className="text-xs text-muted-foreground">{formatDenOrgRoleLabel(invitation.role)} · {invitation.expiresAt && Date.parse(invitation.expiresAt) <= Date.now() ? "Expired" : "Invited"}</p></div>
                    {canInvite ? <Button variant="ghost" size="sm" disabled={busy} aria-label={`Cancel invitation for ${invitation.email}`} onClick={() => { setCompletion(null); invite.reset(); cancel.mutate(invitation.id); }}>{cancel.isPending && cancel.variables === invitation.id ? "Cancelling…" : "Cancel invitation"}</Button> : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </SettingsSection>
  );
}
