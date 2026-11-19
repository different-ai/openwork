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

/**
 * What an invitee gets from shared Gateway grants (Everyone + the chosen team).
 * State in rows, one quiet scope line, no paragraph (DESIGN P1, P6). Never a
 * live readiness claim, and never the inviter's own grants or desktop keys.
 */
export function InviteModelAccessPreviewView({ teamName, state }: { teamName: string | null; state: PreviewState }) {
  const scope = teamName ? `Everyone + ${teamName}` : "Everyone";
  const rows = state.status === "configured" ? state.rows : [];
  return (
    <section className="grid gap-2 border-t border-border pt-4 text-sm" aria-label="Shared models" data-testid="invite-model-access">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-foreground">Shared models</span>
        <span className="text-muted-foreground">{scope}</span>
      </div>
      {state.status === "locked" ? (
        <p className="flex items-start gap-1.5 text-muted-foreground"><Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{permissionLockReason("gateway_providers.view")}</p>
      ) : state.status === "unavailable" ? (
        <p className="text-muted-foreground">AI Gateway isn't set up on this deployment.</p>
      ) : state.status === "checking" ? (
        <div className="grid gap-2" role="status" aria-label="Checking shared models"><DenSkeleton className="h-4 w-3/4" /><DenSkeleton className="h-4 w-1/2" /></div>
      ) : state.status === "error" ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-foreground">Couldn't check shared models. You can still send the invite.</p>
          <DenButton variant="secondary" size="sm" onClick={state.retry}>Try again</DenButton>
        </div>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground">Nothing shared with {scope} yet.</p>
      ) : (
        <details open={rows.length <= 2} data-testid="invite-model-access-details">
          <summary className="cursor-pointer text-muted-foreground">{rows.length} shared {rows.length === 1 ? "provider" : "providers"}</summary>
          <ul className="mt-2 grid max-h-48 gap-2 overflow-y-auto overscroll-contain" aria-label="Configured model grants" tabIndex={0}>
            {rows.map((row) => (
              <li key={row.key} className="grid gap-0.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="font-medium text-foreground">{row.providerName}</span>
                  <span className="text-muted-foreground">{inviteModelAccessStateLabel(row.state)}</span>
                </div>
                {row.modelIds.length > 0 ? (
                  <details className="text-muted-foreground">
                    <summary className="cursor-pointer">{row.modelIds.length} {row.modelIds.length === 1 ? "model" : "models"} · {row.source === "everyone" ? "Everyone" : teamName}</summary>
                    <p className="mt-1 break-words">{inviteModelNames(row)}</p>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
          {rows.some((row) => row.state === "selection_unverified") && state.status === "configured" && state.retry ? (
            <DenButton variant="secondary" size="sm" onClick={state.retry}>Try again</DenButton>
          ) : null}
        </details>
      )}
      <p className="text-muted-foreground">Keys on someone's own computer aren't shared by inviting them.</p>
    </section>
  );
}
