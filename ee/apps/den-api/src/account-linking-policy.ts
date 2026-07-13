import type { BetterAuthOptions } from "better-auth"

export const DEN_ACCOUNT_CONFIG = {
  accountLinking: {
    enabled: true,
    requireLocalEmailVerified: false,
  },
} satisfies NonNullable<BetterAuthOptions["account"]>
