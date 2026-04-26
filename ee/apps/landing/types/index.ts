// types/pill.ts
export interface PillTexture {
  texture: string;
  width: number;
  height: number;
}

export interface PricingPlan {
  name: string;
  tier: string;
  description: string;
  monthlyPrice: number | null;
  annualPrice: number | null;
  seatMonthlyPrice: number | null;
  seatAnnualPrice: number | null;
  credits: number;
  limits: {
    maxAiWorkers: number;
    maxTriggers: number;
    maxConnectors: number;
    maxAiTeams: number;
    maxAgentsPerTeam: number;
    hasPremiumModels: boolean;
    hasAllIntegrations: boolean;
  };
  features: Array<{ label: string; description?: string }>;
  badge: string | null;
  buttonLabel: string;
  isPremium: boolean;
}
