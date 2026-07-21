import type { SocialAuthProvider } from "./den-flow";

const REAUTH_SOCIAL_PROVIDERS: readonly SocialAuthProvider[] = ["google", "github"];

export function resolveReauthMethods(input: {
  providers: readonly string[];
  loading: boolean;
  requiresSso: boolean;
}) {
  if (input.loading || input.requiresSso) {
    return {
      hasPassword: false,
      socialProviders: [] satisfies SocialAuthProvider[],
    };
  }

  return {
    hasPassword: input.providers.length === 0 || input.providers.includes("email"),
    socialProviders: REAUTH_SOCIAL_PROVIDERS.filter((provider) => input.providers.includes(provider)),
  };
}
