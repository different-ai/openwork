import { WORKSHOP_LIMITS, WORKSHOP_SCENES } from "./workshop-narrative-contract.ts";

/** Separate from scene acceptance: a complete matrix must also obey total limits. */
export function workshopRunBudget(rows: readonly { id: string; status: string }[], elapsedMs: number, requests: readonly { inputTokens: number | null; outputTokens: number | null; estimatedUsd: number | null }[]) {
  const reasons: string[] = [];
  if (rows.length !== WORKSHOP_SCENES.length || rows.some((row, index) => row.id !== WORKSHOP_SCENES[index]?.id)) reasons.push("Every scene must execute in the shared order");
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > WORKSHOP_LIMITS.matrixMs) reasons.push("Per-model matrix time budget exceeded or invalid");
  const availableTokens = requests.flatMap((request) => [request.inputTokens, request.outputTokens]).filter((value): value is number => value !== null);
  const availableCost = requests.flatMap((request) => request.estimatedUsd === null ? [] : [request.estimatedUsd]);
  const observedTokens = availableTokens.length ? availableTokens.reduce((sum, value) => sum + value, 0) : null;
  const estimatedUsd = availableCost.length ? availableCost.reduce((sum, value) => sum + value, 0) : null;
  if (availableTokens.some((value) => !Number.isFinite(value) || value < 0) || (observedTokens !== null && observedTokens > WORKSHOP_LIMITS.matrixTokens)) reasons.push("Per-model matrix token budget exceeded or invalid");
  if (availableCost.some((value) => !Number.isFinite(value) || value < 0) || (estimatedUsd !== null && estimatedUsd > WORKSHOP_LIMITS.matrixCostUsd)) reasons.push("Per-model matrix available-request cost estimate exceeded or invalid");
  return { reasons, observedTokens, estimatedUsd, usageComplete: requests.every((request) => request.inputTokens !== null && request.outputTokens !== null && request.estimatedUsd !== null) };
}
