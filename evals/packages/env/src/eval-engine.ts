import { resolveEvalEngineValue } from "@openwork/hosts/eval-engine";
import type { EvalEngine } from "@openwork/hosts/eval-engine";

export type { EvalEngine } from "@openwork/hosts/eval-engine";

export function resolveEvalEngine(env: NodeJS.ProcessEnv = process.env): EvalEngine {
  return resolveEvalEngineValue(env.OPENWORK_EVAL_ENGINE);
}
