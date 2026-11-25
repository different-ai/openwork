# Shared Free Auto budgets

- **Status:** always on; `freeAutoSharedBudgets` was retired in November 2026.

Every signed-in free request counts against the person's weekly allowance, the organization's weekly pool (`INFERENCE_FREE_ORG_WEEKLY_MICRO_USD`, default $25) and the daily ceiling on all signed-in usage (`INFERENCE_FREE_MEMBER_GLOBAL_DAILY_MICRO_USD`, default $350). Guest traffic has its own daily and monthly budgets.

The gateway counts current-period usage. It holds the maximum cost of one supported Luna completion until a usage receipt arrives. A missing receipt keeps the estimate for that request. Update configured token prices alongside provider pricing. See [Limits and safeguards](../../free-auto.md#limits-and-safeguards).
