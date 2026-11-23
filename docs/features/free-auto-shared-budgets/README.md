# Shared Free Auto budgets

The weekly organization budget defaults to $25 and the daily signed-in deployment budget to $100. Configure them with `INFERENCE_FREE_ORG_WEEKLY_MICRO_USD` and `INFERENCE_FREE_MEMBER_GLOBAL_DAILY_MICRO_USD`. The weekly person budget also applies. Guest traffic has its own daily and monthly budgets. Enable the feature deployment-wide for a shared ceiling across all signed-in traffic.

The gateway counts current-period usage, including calls from before rollout. It holds the maximum cost of one supported Luna completion until a usage receipt arrives. A missing receipt keeps the estimate for that request. Update configured token prices alongside provider pricing. Deploy all gateway replicas before enabling enforcement.
