export type EvalEngine = "v1" | "v2";

export function resolveEvalEngineValue(value: string | undefined): EvalEngine {
  if (value === undefined) return "v1";
  const normalized = value.trim().toLowerCase();
  if (normalized === "v1" || normalized === "v2") return normalized;
  throw new Error(`Invalid OPENWORK_EVAL_ENGINE value ${JSON.stringify(value)}; expected "v1" or "v2".`);
}
