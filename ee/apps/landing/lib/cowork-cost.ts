import type { ModelPrice } from "./model-prices";

/** Date the Anthropic plan facts below were checked against Anthropic's public pages. */
export const anthropicPricingCheckedAt = "2026-09-25";

export const pricingSources = [
  { label: "Claude Team plan", href: "https://support.claude.com/en/articles/9266767-what-is-the-team-plan" },
  { label: "Claude Enterprise pricing", href: "https://claude.com/pricing/enterprise" },
  { label: "Claude Desktop on third-party platforms", href: "https://claude.com/docs/third-party/claude-desktop/overview" },
  { label: "OpenWork pricing", href: "/pricing" },
  { label: "Model prices from models.dev", href: "https://models.dev" }
];

export type UsageProfileId = "light" | "typical" | "heavy";

export const usageProfileIds: UsageProfileId[] = ["light", "typical", "heavy"];

export type Usage = {
  /** Million input tokens per active user per month, cached and uncached. */
  inputMillions: number;
  /** Million output tokens per active user per month. */
  outputMillions: number;
  /** Share of input tokens billed at the cache-read price, 0–1. */
  cacheReadShare: number;
};

export const usageProfiles: Record<UsageProfileId, { label: string; usage: Usage }> = {
  light: { label: "Light", usage: { inputMillions: 5, outputMillions: 0.3, cacheReadShare: 0.7 } },
  typical: { label: "Typical", usage: { inputMillions: 25, outputMillions: 1.2, cacheReadShare: 0.7 } },
  heavy: { label: "Heavy agentic", usage: { inputMillions: 100, outputMillions: 4, cacheReadShare: 0.7 } }
};

export type Billing = "annual" | "monthly";

export type CostInputs = {
  users: number;
  usage: Usage;
  claudeModel: ModelPrice;
  openworkModel: ModelPrice;
  /** Optional cheaper model that takes `routeShare` of OpenWork usage. */
  routeModel: ModelPrice;
  /** Share of OpenWork usage sent to `routeModel`, 0–1. */
  routeShare: number;
  claudeTeamBilling: Billing;
};

export type PlanId =
  | "claude-team-standard"
  | "claude-team-premium"
  | "claude-enterprise"
  | "claude-3p"
  | "openwork-team"
  | "openwork-enterprise";

export type PlanCost = {
  id: PlanId;
  vendor: "claude" | "openwork";
  name: string;
  modelLabel: string;
  available: boolean;
  seatsBilled: number;
  seatMonthly: number;
  tokensMonthly: number;
  totalMonthly: number;
  totalAnnual: number;
  perUserMonthly: number;
  notes: string[];
};

export const planPrices = {
  claudeTeamStandard: { monthly: 25, annual: 20 },
  claudeTeamPremium: { monthly: 125, annual: 100 },
  claudeTeamMinSeats: 2,
  claudeTeamMaxSeats: 150,
  claudeEnterpriseSeat: 20,
  claudeEnterpriseMinSeats: 20,
  openworkTeamSeat: 10,
  openworkFreeMaxUsers: 5,
  openworkEnterpriseSeat: 40,
  openworkEnterpriseVolumeAbove: 250
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Monthly token cost for one active user on one model, in USD. */
export function tokenCostPerUser(model: ModelPrice, usage: Usage): number {
  const input = Math.max(0, usage.inputMillions);
  const output = Math.max(0, usage.outputMillions);
  const cacheShare = clamp(usage.cacheReadShare, 0, 1);
  const cacheRead = model.cacheRead ?? model.input;
  return input * ((1 - cacheShare) * model.input + cacheShare * cacheRead) + output * model.output;
}

/** Monthly token cost for one user when part of the work goes to a second model. */
export function blendedTokenCostPerUser(primary: ModelPrice, route: ModelPrice, routeShare: number, usage: Usage): number {
  const share = clamp(routeShare, 0, 1);
  return (1 - share) * tokenCostPerUser(primary, usage) + share * tokenCostPerUser(route, usage);
}

/** True when a usage profile is heavy enough that Claude Team seat limits are likely to be reached. */
export function likelyExceedsTeamLimits(usage: Usage): boolean {
  const typical = usageProfiles.typical.usage;
  return usage.inputMillions >= typical.inputMillions || usage.outputMillions >= typical.outputMillions;
}

function plan(
  base: Omit<PlanCost, "totalMonthly" | "totalAnnual" | "perUserMonthly">,
  users: number
): PlanCost {
  const totalMonthly = base.seatMonthly + base.tokensMonthly;
  return {
    ...base,
    totalMonthly,
    totalAnnual: totalMonthly * 12,
    perUserMonthly: users > 0 ? totalMonthly / users : 0
  };
}

export function calculatePlanCosts(inputs: CostInputs): PlanCost[] {
  const users = Math.round(clamp(inputs.users, 1, 1_000_000));
  const claudeTokens = tokenCostPerUser(inputs.claudeModel, inputs.usage) * users;
  const routeShare = clamp(inputs.routeShare, 0, 1);
  const openworkTokens = blendedTokenCostPerUser(inputs.openworkModel, inputs.routeModel, routeShare, inputs.usage) * users;
  const openworkModelLabel =
    routeShare > 0 && inputs.routeModel.id !== inputs.openworkModel.id
      ? `${inputs.openworkModel.label} + ${Math.round(routeShare * 100)}% ${inputs.routeModel.label}`
      : inputs.openworkModel.label;
  const heavy = likelyExceedsTeamLimits(inputs.usage);
  const teamAvailable = users <= planPrices.claudeTeamMaxSeats;
  const teamSeats = Math.max(users, planPrices.claudeTeamMinSeats);
  const teamNotes = [
    "Usage included up to weekly limits. Usage beyond limits is billed as usage credits at API rates and is not included here.",
    ...(heavy ? ["At this usage, many people are likely to reach weekly limits."] : []),
    ...(teamAvailable ? [] : [`Team plan allows up to ${planPrices.claudeTeamMaxSeats} seats.`])
  ];
  const enterpriseSeats = Math.max(users, planPrices.claudeEnterpriseMinSeats);

  return [
    plan(
      {
        id: "claude-team-standard",
        vendor: "claude",
        name: "Claude Team, Standard seat",
        modelLabel: "Claude models, within plan limits",
        available: teamAvailable,
        seatsBilled: teamSeats,
        seatMonthly: teamSeats * planPrices.claudeTeamStandard[inputs.claudeTeamBilling],
        tokensMonthly: 0,
        notes: teamNotes
      },
      users
    ),
    plan(
      {
        id: "claude-team-premium",
        vendor: "claude",
        name: "Claude Team, Premium seat",
        modelLabel: "Claude models, within plan limits",
        available: teamAvailable,
        seatsBilled: teamSeats,
        seatMonthly: teamSeats * planPrices.claudeTeamPremium[inputs.claudeTeamBilling],
        tokensMonthly: 0,
        notes: teamNotes.filter((note) => !note.startsWith("At this usage"))
      },
      users
    ),
    plan(
      {
        id: "claude-enterprise",
        vendor: "claude",
        name: "Claude Enterprise",
        modelLabel: inputs.claudeModel.label,
        available: true,
        seatsBilled: enterpriseSeats,
        seatMonthly: enterpriseSeats * planPrices.claudeEnterpriseSeat,
        tokensMonthly: claudeTokens,
        notes: [
          "Seat covers access only; all usage billed at API rates. Seat price billed annually.",
          ...(users < planPrices.claudeEnterpriseMinSeats
            ? [`Minimum ${planPrices.claudeEnterpriseMinSeats} seats.`]
            : [])
        ]
      },
      users
    ),
    plan(
      {
        id: "claude-3p",
        vendor: "claude",
        name: "Claude Desktop on 3P",
        modelLabel: inputs.claudeModel.label,
        available: true,
        seatsBilled: 0,
        seatMonthly: 0,
        tokensMonthly: claudeTokens,
        notes: ["No seat fee. Tokens billed by your cloud provider; committed-spend discounts not included."]
      },
      users
    ),
    plan(
      {
        id: "openwork-team",
        vendor: "openwork",
        name: "OpenWork Team",
        modelLabel: openworkModelLabel,
        available: true,
        seatsBilled: users,
        seatMonthly: users * planPrices.openworkTeamSeat,
        tokensMonthly: openworkTokens,
        notes: [
          "Tokens billed by your own provider or gateway.",
          ...(users <= planPrices.openworkFreeMaxUsers
            ? [`The Free plan covers up to ${planPrices.openworkFreeMaxUsers} users with no seat fee.`]
            : [])
        ]
      },
      users
    ),
    plan(
      {
        id: "openwork-enterprise",
        vendor: "openwork",
        name: "OpenWork Enterprise",
        modelLabel: openworkModelLabel,
        available: true,
        seatsBilled: users,
        seatMonthly: users * planPrices.openworkEnterpriseSeat,
        tokensMonthly: openworkTokens,
        notes: [
          "Billed annually. Same price cloud or self-hosted.",
          ...(users > planPrices.openworkEnterpriseVolumeAbove
            ? [`Volume pricing above ${planPrices.openworkEnterpriseVolumeAbove} users. Talk to sales.`]
            : [])
        ]
      },
      users
    )
  ];
}
