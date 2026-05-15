import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";

const PINNED_PROVIDER_ORDER = ["opencode", "openai", "anthropic"] as const;

export const providerPriorityRank = (id: string) => {
  const normalized = id.trim().toLowerCase();
  const index = PINNED_PROVIDER_ORDER.indexOf(
    normalized as (typeof PINNED_PROVIDER_ORDER)[number],
  );
  return index === -1 ? PINNED_PROVIDER_ORDER.length : index;
};

export const compareProviders = (
  a: { id: string; name?: string },
  b: { id: string; name?: string },
) => {
  const rankDiff = providerPriorityRank(a.id) - providerPriorityRank(b.id);
  if (rankDiff !== 0) return rankDiff;

  const aName = (a.name ?? a.id).trim();
  const bName = (b.name ?? b.id).trim();
  return aName.localeCompare(bName);
};

export const filterProviderList = (
  value: ProviderListResponse,
  disabledProviders: string[],
): ProviderListResponse => {
  const disabled = new Set(disabledProviders.flatMap((id) => {
    const trimmed = id.trim();
    return trimmed ? [trimmed] : [];
  }));
  if (!disabled.size) return value;
  return {
    all: value.all.filter((provider) => !disabled.has(provider.id)),
    connected: value.connected.filter((id) => !disabled.has(id)),
    default: Object.fromEntries(
      Object.entries(value.default).filter(([id]) => !disabled.has(id)),
    ),
  };
};
