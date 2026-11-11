"use client";

import { Lock } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { permissionLockReason } from "../../_lib/den-org";
import { useGatewayAccessProviders } from "./gateway-subject-access-data";
import { inviteModelAccess, inviteModelAccessStateLabel, type InviteModelAccess } from "./invite-model-access";

type PreviewState =
  | { status: "locked" | "unavailable" | "checking" }
  | { status: "error"; retry: () => void }
  | { status: "configured"; rows: InviteModelAccess[]; retry?: () => void };

/** Mounted only while a flagged invite form is open; it never gates Send invite. */
export function InviteModelAccessPreview({ orgId, team, canViewProviders, gatewayAvailable }: {
  orgId: string;
  team: { id: string; name: string } | null;
  canViewProviders: boolean;
  gatewayAvailable: boolean;
}) {
  const providers = useGatewayAccessProviders(orgId, canViewProviders && gatewayAvailable);
  const state: PreviewState = !canViewProviders ? { status: "locked" }
    : !gatewayAvailable ? { status: "unavailable" }
    : providers.isFetching || providers.isPending ? { status: "checking" }
    : providers.isError ? { status: "error", retry: () => { void providers.refetch(); } }
    : { status: "configured", rows: inviteModelAccess(providers.data ?? [], team?.id ?? null), retry: () => { void providers.refetch(); } };
  return <InviteModelAccessPreviewView teamName={team?.name ?? null} state={state} />;
}

function inviteModelNames(row: InviteModelAccess): string {
  const known = row.modelNames.filter((name): name is string => name !== null);
  const unavailable = row.modelIds.length - known.length;
  return [...known, ...(unavailable ? [`${unavailable} model ${unavailable === 1 ? "name" : "names"} unavailable`] : [])].join(", ");
}

export function InviteModelAccessPreviewView({ teamName, state }: { teamName: string | null; state: PreviewState }) {
  return (
    <section className="grid gap-2 border-t border-border pt-4 text-sm" aria-label="Shared AI model access" data-testid="invite-model-access">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-foreground">Shared AI model access only</span>
        <span className="text-muted-foreground">{teamName ? `Everyone + ${teamName}` : "Everyone"}</span>
      </div>
      {state.status === "locked" ? (
        <p className="flex items-start gap-1.5 text-muted-foreground"><Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{`Preview locked. ${permissionLockReason("gateway_providers.view")}`}</p>
      ) : state.status === "unavailable" ? (
        <p className="text-muted-foreground">Shared model access could not be verified on this deployment.</p>
      ) : state.status === "checking" ? (
        <div className="grid gap-2" role="status" aria-label="Checking shared model access"><DenSkeleton className="h-4 w-3/4" /><DenSkeleton className="h-4 w-1/2" /></div>
      ) : state.status === "error" ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-foreground">Shared model access could not be verified. You can still send the invite.</p>
          <DenButton variant="secondary" size="sm" onClick={state.retry}>Try again</DenButton>
        </div>
      ) : state.status === "configured" && state.rows.length === 0 ? (
        <p className="text-muted-foreground">No shared models configured for {teamName ? `Everyone or ${teamName}` : "Everyone"}.</p>
      ) : (
        <details open={state.status === "configured" && state.rows.length <= 2} data-testid="invite-model-access-details">
          <summary className="cursor-pointer text-muted-foreground">{state.status === "configured" ? state.rows.length : 0} shared model groups</summary>
          <ul className="mt-2 grid max-h-48 gap-3 overflow-y-auto overscroll-contain" aria-label="Configured model grants" tabIndex={0}>
            {(state.status === "configured" ? state.rows : []).map((row) => (
              <li key={row.key} className="grid gap-1">
                <div className="font-medium text-foreground">{row.providerName} · {row.groupName}</div>
                {row.modelIds.length > 0 ? <div className="break-words text-muted-foreground">{inviteModelNames(row)}</div> : null}
                <div className="text-muted-foreground">{inviteModelAccessStateLabel(row.state)} · {row.source === "everyone" ? "From Everyone" : `From ${teamName}`}</div>
              </li>
            ))}
          </ul>
          {state.status === "configured" && state.rows.some((row) => row.state === "selection_unverified") && state.retry ? (
            <DenButton variant="secondary" size="sm" onClick={state.retry}>Try again</DenButton>
          ) : null}
        </details>
      )}
      <p className="text-muted-foreground">Personal desktop keys are not shared by an invite. Existing members may have other personal grants not shown here. Shared configuration only, not a live model test; usage limits still apply.</p>
    </section>
  );
}
