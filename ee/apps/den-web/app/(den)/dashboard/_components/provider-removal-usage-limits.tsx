"use client";

import { useState } from "react";
import type {
  GatewayProviderRemovalLimitChoice,
  GatewayProviderRemovalUsageLimit,
  GatewayUsageLimitPolicy,
} from "@openwork/types/den/gateway-usage-limits";
import { describeLimitAmounts, useGatewayPolicies } from "./gateway-usage-limits-data";
import { ProviderHasUsageLimitsError } from "./inference-provider-data";

export type ProviderMoveTarget = { id: string; name: string; status: string };

/** The active limits scoped to a provider, as the delete route lists them. */
export function providerUsageLimits(policies: GatewayUsageLimitPolicy[], providerId: string): GatewayProviderRemovalUsageLimit[] {
  return policies
    .filter((policy) => !policy.archivedAt && policy.providerId === providerId)
    .map(({ id, name, revision, hardLimit, limits }) => ({ id, name, revision, hardLimit, limits }));
}

/** Other active providers of the organization the limits can move to. */
export function providerMoveTargets(providers: ProviderMoveTarget[], removedProviderId: string): ProviderMoveTarget[] {
  return providers.filter((provider) => provider.id !== removedProviderId && provider.status === "active");
}

function sameChoice(a: GatewayProviderRemovalLimitChoice, b: GatewayProviderRemovalLimitChoice) {
  return a.action === b.action && (a.action !== "move" || (b.action === "move" && a.providerId === b.providerId));
}

/**
 * What happens to a provider's spend limits when it is removed.
 * Read limits up front when the person may view them; the server's 409 list is authoritative.
 */
export function useProviderRemovalUsageLimits({ orgId, providerId, open, providers }: {
  orgId: string | null;
  providerId: string;
  open: boolean;
  providers: ProviderMoveTarget[];
}) {
  const policies = useGatewayPolicies(orgId ?? "", { enabled: open && Boolean(orgId) });
  const [fromServer, setFromServer] = useState<GatewayProviderRemovalUsageLimit[] | null>(null);
  const [picked, setPicked] = useState<GatewayProviderRemovalLimitChoice | null>(null);
  const targets = providerMoveTargets(providers, providerId);
  const usageLimits = fromServer ?? (policies.data ? providerUsageLimits(policies.data.policies, providerId) : []);
  const fallback: GatewayProviderRemovalLimitChoice = targets[0] ? { action: "move", providerId: targets[0].id } : { action: "archive" };
  const pickedStillValid = picked && (picked.action === "archive" || targets.some((target) => target.id === picked.providerId));
  const choice = pickedStillValid ? picked : fallback;
  return {
    usageLimits,
    targets,
    choice,
    setChoice: setPicked,
    /** The choice to send with the delete, only once limits are known to exist. */
    requestChoice(): GatewayProviderRemovalLimitChoice | undefined {
      if (!usageLimits.length) return undefined;
      return choice;
    },
    /** True when the delete stopped because the provider has limits; the dialog then asks. */
    handleRemoveError(error: unknown) {
      if (!(error instanceof ProviderHasUsageLimitsError)) return false;
      setFromServer(error.usageLimits);
      return true;
    },
    reset() {
      setFromServer(null);
      setPicked(null);
    },
  };
}

/** The affected limits and the move/delete choice, shown inside the remove-provider dialog. */
export function ProviderRemovalUsageLimits({ providerName, usageLimits, targets, choice, onChange, disabled = false }: {
  providerName: string;
  usageLimits: GatewayProviderRemovalUsageLimit[];
  targets: ProviderMoveTarget[];
  choice: GatewayProviderRemovalLimitChoice;
  onChange: (choice: GatewayProviderRemovalLimitChoice) => void;
  disabled?: boolean;
}) {
  if (!usageLimits.length) return null;
  const options: { key: string; label: string; value: GatewayProviderRemovalLimitChoice }[] = [
    ...targets.map((target) => ({ key: target.id, label: `${usageLimits.length === 1 ? "Move the limit" : "Move limits"} to ${target.name}`, value: { action: "move" as const, providerId: target.id } })),
    { key: "archive", label: usageLimits.length === 1 ? "Delete the limit too" : "Delete the limits too", value: { action: "archive" } },
  ];
  return (
    <div className="mt-4 flex flex-col gap-3" data-testid="gateway-provider-remove-limits">
      <p className="text-[13px] font-medium text-gray-900">
        {usageLimits.length === 1 ? "1 spend limit uses" : `${usageLimits.length} spend limits use`} {providerName}
      </p>
      <ul className="divide-y divide-gray-100 rounded-[10px] border border-gray-100" aria-label={`Spend limits on ${providerName}`}>
        {usageLimits.map((limit) => (
          <li key={limit.id} className="flex items-center gap-3 px-3 py-2.5 text-[13px]" data-testid="gateway-provider-remove-limit">
            <span className="min-w-0 flex-1 truncate font-medium text-gray-900">{limit.name}</span>
            <span className="shrink-0 tabular-nums text-gray-600">{describeLimitAmounts(limit)}</span>
          </li>
        ))}
      </ul>
      <fieldset className="flex flex-col" disabled={disabled}>
        <legend className="sr-only">What happens to these limits</legend>
        {options.map((option) => (
          <label key={option.key} className="flex cursor-pointer items-center gap-2.5 py-1.5 text-[13px] text-gray-900">
            <input
              type="radio"
              name="gateway-provider-remove-limits"
              checked={sameChoice(choice, option.value)}
              onChange={() => onChange(option.value)}
              className="h-4 w-4 accent-gray-900"
              data-testid={option.value.action === "move" ? "gateway-provider-remove-limits-move" : "gateway-provider-remove-limits-archive"}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
    </div>
  );
}
