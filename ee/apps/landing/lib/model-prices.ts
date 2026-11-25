export type ModelPrice = {
  id: string;
  provider: string;
  providerName: string;
  label: string;
  input: number;
  output: number;
  cacheRead: number | null;
  claude: boolean;
};

export { modelPrices, modelPricesFetchedAt } from "./model-prices.generated";
