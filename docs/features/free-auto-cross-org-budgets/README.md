# Cross-organization free model budgets

- **Status:** always on; `freeAutoCrossOrgBudgets` was retired in November 2026.

People can create organizations and invite teammates as usual. All organizations founded by one account share the organization weekly allowance (`INFERENCE_FREE_ORG_WEEKLY_MICRO_USD`). Each account also has its own weekly cap across computers. Once signed desktops are required (`DESKTOP_FREE_MIN_VERSION`), all signed-in accounts using one desktop also share one personal-sized weekly allowance, and coworkers sharing a computer draw from it. Hosted Workbot requests count toward the person and founder budgets but not a desktop cap.

Den records the founder when an organization is created or a person claims a provisional workspace. Ownership transfers keep the original attribution. An organization with no recorded founder uses its own weekly pool. The founder pool counts this week's existing usage in attributed organizations. The gateway stores a keyed hash from the verified desktop session; keep the accounting identity key stable during the budget window. Distinct founding accounts on distinct computers qualify independently. The daily ceiling bounds signed-in spend across those pools.
