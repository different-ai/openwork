export type ModelPrice = {
  id: string;
  provider: string;
  providerName: string;
  label: string;
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cached input tokens; null when the provider publishes none. */
  cacheRead: number | null;
  /** Claude models are the only ones Claude Cowork can use. */
  claude: boolean;
};

export { modelPrices, modelPricesFetchedAt } from "./model-prices.generated";
