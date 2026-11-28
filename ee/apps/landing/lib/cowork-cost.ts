import type { ModelPrice } from "./model-prices";

export const anthropicPricingCheckedAt = "2026-11-27";

export const pricingSources = [
  { label: "Claude plans", href: "https://claude.com/pricing" },
  { label: "Claude Team plan", href: "https://support.claude.com/en/articles/9266767-what-is-the-team-plan" },
  { label: "Claude Enterprise pricing", href: "https://claude.com/pricing/enterprise" },
  { label: "OpenWork pricing", href: "/pricing" },
  { label: "Model prices from models.dev", href: "https://models.dev" }
];

export type UsageProfileId = "light" | "typical" | "heavy";

export const usageProfileIds: UsageProfileId[] = ["light", "typical", "heavy"];

export type Usage = {
  inputMillions: number;
  outputMillions: number;
  cacheReadShare: number;
};

export const usageProfiles: Record<UsageProfileId, { label: string; usage: Usage }> = {
  light: { label: "Light", usage: { inputMillions: 5, outputMillions: 0.3, cacheReadShare: 0.7 } },
  typical: { label: "Typical", usage: { inputMillions: 25, outputMillions: 1.2, cacheReadShare: 0.7 } },
  heavy: { label: "Heavy agentic", usage: { inputMillions: 100, outputMillions: 4, cacheReadShare: 0.7 } }
};

export const planPrices = {
  claudePro: { monthly: 20, annual: 17, annualUpFront: 200 },
  claudeMax: 100,
  claudeUltra: 200,
  claudeTeamStandard: { monthly: 25, annual: 20 },
  claudeTeamPremium: { monthly: 125, annual: 100 },
  claudeTeamMinSeats: 2,
  claudeTeamMaxSeats: 150,
  claudeEnterpriseSeat: 20,
  claudeEnterpriseMinSeats: 20,
  openworkTeamSeat: 10,
  openworkFreeSeats: 5,
  openworkEnterpriseSeat: 20,
  openworkEnterpriseVolumeAbove: 250
};

export const openworkEnterpriseVolumeTiers: { upTo: number; price: number }[] = [
  { upTo: 250, price: 20 },
  { upTo: 1000, price: 16 },
  { upTo: Number.POSITIVE_INFINITY, price: 13 }
];

export function describeEnterpriseVolumeTiers(): string {
  const count = new Intl.NumberFormat("en-US");
  let previous = 0;
  const parts = openworkEnterpriseVolumeTiers.map((tier, index) => {
    const from = previous + 1;
    previous = tier.upTo;
    if (index === 0) return `$${tier.price} a person a month for the first ${count.format(tier.upTo)}`;
    if (!Number.isFinite(tier.upTo)) return `$${tier.price} above`;
    return `$${tier.price} for seats ${count.format(from)}–${count.format(tier.upTo)}`;
  });
  return parts.join(", ");
}

export function openworkEnterpriseSeatsMonthly(seats: number): number {
  let remaining = Math.max(0, Math.round(seats));
  let previous = 0;
  let total = 0;
  for (const tier of openworkEnterpriseVolumeTiers) {
    const inTier = Math.min(remaining, tier.upTo - previous);
    total += inTier * tier.price;
    remaining -= inTier;
    previous = tier.upTo;
    if (remaining <= 0) break;
  }
  return total;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function tokenCostPerUser(model: ModelPrice, usage: Usage): number {
  const input = Math.max(0, usage.inputMillions);
  const output = Math.max(0, usage.outputMillions);
  const cacheShare = clamp(usage.cacheReadShare, 0, 1);
  const cacheRead = model.cacheRead ?? model.input;
  return input * ((1 - cacheShare) * model.input + cacheShare * cacheRead) + output * model.output;
}

export function likelyExceedsTeamLimits(usage: Usage): boolean {
  const typical = usageProfiles.typical.usage;
  return usage.inputMillions >= typical.inputMillions || usage.outputMillions >= typical.outputMillions;
}

export function needsPremiumSeat(usage: Usage): boolean {
  return likelyExceedsTeamLimits(usage);
}

export type Tier = "team" | "enterprise";

export const mixShares = [0, 0.5, 0.7, 0.9] as const;

export type MixShare = (typeof mixShares)[number];

export const defaultMixShare: MixShare = 0.7;

export type ModelMix = {
  openModel: ModelPrice;
  openShare: number;
};

export function blendedTokenCostPerUser(claudeModel: ModelPrice, mix: ModelMix, usage: Usage): number {
  const share = clamp(mix.openShare, 0, 1);
  return share * tokenCostPerUser(mix.openModel, usage) + (1 - share) * tokenCostPerUser(claudeModel, usage);
}

export function mixLabel(claudeModel: ModelPrice, mix: ModelMix): string {
  const open = Math.round(clamp(mix.openShare, 0, 1) * 100);
  return `${open}% ${mix.openModel.label}, ${100 - open}% ${claudeModel.label}`;
}

export function perPersonMonthly(series: CostSeries, users: number): number {
  return Math.round(series.monthly / Math.max(1, Math.round(users)));
}

export type SeriesId = "claude-team" | "claude-enterprise" | "claude-3p" | "openwork-team" | "openwork-enterprise";

export type CostSeries = {
  id: SeriesId;
  vendor: "claude" | "openwork";
  name: string;
  modelLabel: string;
  seatsBilled: number;
  seatsMonthly: number;
  tokensMonthly: number;
  tokensIncluded: boolean;
  monthly: number;
  points: number[];
  total: number;
};

export type CumulativeInputs = {
  users: number;
  usage: Usage;
  tier: Tier;
  model: ModelPrice;
  mix?: ModelMix | null;
  months: number;
};

export type CumulativeCosts = {
  users: number;
  months: number;
  claude: CostSeries;
  openwork: CostSeries;
  mix: CostSeries | null;
  claude3p: CostSeries;
  claudeTeamUnavailable: boolean;
  claudeTeamSeat: "standard" | "premium" | null;
  savings: number;
  mixSavings: number | null;
};

function series(
  base: Omit<CostSeries, "monthly" | "points" | "total">,
  months: number
): CostSeries {
  const monthly = base.seatsMonthly + base.tokensMonthly;
  const points = Array.from({ length: months + 1 }, (_, month) => monthly * month);
  return { ...base, monthly, points, total: monthly * months };
}

export function cumulativeCosts(inputs: CumulativeInputs): CumulativeCosts {
  const users = Math.round(clamp(inputs.users, 1, 1_000_000));
  const months = Math.round(clamp(inputs.months, 1, 120));
  const tokens = tokenCostPerUser(inputs.model, inputs.usage) * users;
  const claudeTeamUnavailable = inputs.tier === "team" && users > planPrices.claudeTeamMaxSeats;
  const useClaudeTeam = inputs.tier === "team" && !claudeTeamUnavailable;
  const premium = needsPremiumSeat(inputs.usage);

  let claude: CostSeries;
  if (useClaudeTeam) {
    const seats = Math.max(users, planPrices.claudeTeamMinSeats);
    const seatPrice = premium ? planPrices.claudeTeamPremium.annual : planPrices.claudeTeamStandard.annual;
    claude = series(
      {
        id: "claude-team",
        vendor: "claude",
        name: premium ? "Claude Team, Premium seats" : "Claude Team",
        modelLabel: "Claude models, within plan limits",
        seatsBilled: seats,
        seatsMonthly: seats * seatPrice,
        tokensMonthly: 0,
        tokensIncluded: true
      },
      months
    );
  } else {
    const seats = Math.max(users, planPrices.claudeEnterpriseMinSeats);
    claude = series(
      {
        id: "claude-enterprise",
        vendor: "claude",
        name: "Claude Enterprise",
        modelLabel: inputs.model.label,
        seatsBilled: seats,
        seatsMonthly: seats * planPrices.claudeEnterpriseSeat,
        tokensMonthly: tokens,
        tokensIncluded: false
      },
      months
    );
  }

  const openworkSeats =
    inputs.tier === "team" ? (users > planPrices.openworkFreeSeats ? users : 0) : users;
  const openworkSeatsMonthly =
    inputs.tier === "team"
      ? openworkSeats * planPrices.openworkTeamSeat
      : openworkEnterpriseSeatsMonthly(openworkSeats);
  const openworkBase: Omit<CostSeries, "monthly" | "points" | "total" | "modelLabel" | "tokensMonthly"> = {
    id: inputs.tier === "team" ? "openwork-team" : "openwork-enterprise",
    vendor: "openwork",
    name: inputs.tier === "team" ? "OpenWork Team" : "OpenWork Enterprise",
    seatsBilled: openworkSeats,
    seatsMonthly: openworkSeatsMonthly,
    tokensIncluded: false
  };
  const openwork = series({ ...openworkBase, modelLabel: inputs.model.label, tokensMonthly: tokens }, months);
  const mixInput = inputs.mix && inputs.mix.openShare > 0 ? inputs.mix : null;
  const mix = mixInput
    ? series(
        {
          ...openworkBase,
          modelLabel: mixLabel(inputs.model, mixInput),
          tokensMonthly: blendedTokenCostPerUser(inputs.model, mixInput, inputs.usage) * users
        },
        months
      )
    : null;

  const claude3p = series(
    {
      id: "claude-3p",
      vendor: "claude",
      name: "Claude Desktop on 3P",
      modelLabel: inputs.model.label,
      seatsBilled: 0,
      seatsMonthly: 0,
      tokensMonthly: tokens,
      tokensIncluded: false
    },
    months
  );

  return {
    users,
    months,
    claude,
    openwork,
    mix,
    claude3p,
    claudeTeamUnavailable,
    claudeTeamSeat: useClaudeTeam ? (premium ? "premium" : "standard") : null,
    savings: claude.total - openwork.total,
    mixSavings: mix ? claude.total - mix.total : null
  };
}
