/** A default limit excludes providers with their own applicable limit. */
export const defaultProviderLimitLabel = "Providers without their own limit";

export function providerLimitLabel(providerId: string | null | undefined, providers: { id: string; name: string }[] | undefined): string {
  if (!providerId) return defaultProviderLimitLabel;
  const known = providers?.find((provider) => provider.id === providerId);
  if (known) return known.name;
  return providers ? "Provider not in current list" : "Saved provider (unverified)";
}
