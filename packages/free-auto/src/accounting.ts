import { INFERENCE_USAGE_CONVERSION_FACTOR } from "@openwork/types/den/inference";

/**
 * Free Auto accounting rules shared by the Gateway (which charges) and Den
 * (which reports balances). Amounts are in inference usage units
 * (INFERENCE_USAGE_CONVERSION_FACTOR per USD).
 */

export type FreePrices = { inputPrice: number; outputPrice: number };
/** Cost of a completion from its token counts, rounded up. Prices are USD per million tokens. */
export function freeUsageAmount(prices: FreePrices, inputTokens: number, outputTokens: number): number {
  // Luna prices the entire request at long-context rates once input exceeds 272K tokens.
  const longContext = inputTokens > 272_000;
  return Math.ceil((inputTokens * prices.inputPrice * (longContext ? 2 : 1) + outputTokens * prices.outputPrice * (longContext ? 1.5 : 1)) * INFERENCE_USAGE_CONVERSION_FACTOR / 1000000);
}

/** Guest allowance tiers by minutes with the app open; ascending, first tier at 0. */
export type InstallRamp = ReadonlyArray<{ minutes: number; amount: number }>;
export const DEFAULT_INSTALL_RAMP = "0:100000,10:200000,20:500000,30:1000000";
/** Parses "activeMinutes:microUsd,…"; each step is capped at the device budget. Throws on anything malformed. */
export function parseInstallRamp(source: string, deviceWeeklyAmount: number): InstallRamp {
  const ramp = source.split(",").map((entry) => {
    const [minutes, micro] = entry.split(":").map((value) => Number(value.trim()));
    if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > 525600 || !Number.isSafeInteger(micro) || micro < 1) throw new Error("Invalid ANONYMOUS_INSTALL_RAMP");
    return { minutes, amount: Math.min(micro * 100, deviceWeeklyAmount) };
  });
  if (ramp[0].minutes !== 0 || ramp.some((step, index) => index > 0 && (step.minutes <= ramp[index - 1].minutes || step.amount < ramp[index - 1].amount))) {
    throw new Error("Invalid ANONYMOUS_INSTALL_RAMP");
  }
  return ramp;
}
/** The device allowance for a guest machine that has had the app open for `activeMs`. */
export function rampedDeviceAmount(input: { installRamp: InstallRamp; deviceWeeklyAmount: number }, activeMs: number): number {
  const minutes = Math.max(0, activeMs) / 60000;
  let amount = input.installRamp[0].amount;
  for (const step of input.installRamp) if (minutes >= step.minutes) amount = step.amount;
  return Math.min(amount, input.deviceWeeklyAmount);
}
