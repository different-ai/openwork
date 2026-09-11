/** Only pass env names from the trusted catalog, never request bodies or stored custom config. */
export function inferenceCredentialEnvNames(trustedEnvNames: readonly string[]): string[] {
  const ranked = [...new Set(trustedEnvNames)].flatMap((name) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)
      || /(?:^|_)(?:RESOURCE|PROJECT|LOCATION|REGION|ACCOUNT|TENANT|ENDPOINT|URL|SETTINGS|INPUT|OUTPUT)(?:_|$)/.test(name)) return []
    const rank = /(?:^|_)API_KEY$/.test(name) ? 0
      : /(?:^|_)API_TOKEN$/.test(name) ? 1
        : /(?:^|_)BEARER_TOKEN$/.test(name) ? 2 : null
    return rank === null ? [] : [{ name, rank }]
  })
  return ranked.sort((left, right) => left.rank - right.rank).map(({ name }) => name)
}

/** Unknown fields, settings-only maps, and competing keys of the same rank fail closed. */
export function pickInferenceApiKeyFromMap(apiKeys: Record<string, string>, trustedEnvNames: readonly string[]): string | null {
  if (Object.keys(apiKeys).some((name) => !trustedEnvNames.includes(name))) return null
  const names = inferenceCredentialEnvNames(trustedEnvNames).filter((name) => apiKeys[name]?.trim())
  const first = names[0]
  if (!first) return null
  const suffix = first.endsWith("API_KEY") ? "API_KEY" : first.endsWith("API_TOKEN") ? "API_TOKEN" : "BEARER_TOKEN"
  if (names.filter((name) => name.endsWith(suffix)).length !== 1) return null
  return apiKeys[first]
}

export function isInferenceCredentialKindSupported(kind: string, providerId: string): boolean {
  const vertex = providerId === "google-vertex" || providerId === "google-vertex-anthropic"
  return !(((kind === "gcp_service_account" || kind === "oauth_google") && !vertex)
    || (kind === "aws_keys" && providerId !== "amazon-bedrock")
    || kind === "oauth_azure" || (kind === "api_key_map" && vertex))
}
