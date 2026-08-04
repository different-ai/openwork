export interface NeedsSpec {
  model?: "tool-capable";
  env?: string[];
  optIn?: string[];
  daytona?: boolean;
}

export class SkipError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`needs: ${reason}`);
    this.name = "SkipError";
    this.reason = reason;
  }
}

function present(env: NodeJS.ProcessEnv, name: string): boolean {
  return Boolean(env[name]?.trim());
}

export function unmetNeeds(spec: NeedsSpec, env: NodeJS.ProcessEnv): string[] {
  const missing: string[] = [];
  for (const name of spec.env ?? []) {
    if (!present(env, name)) missing.push(`set ${name}`);
  }
  for (const name of spec.optIn ?? []) {
    if (env[name]?.trim() !== "1") missing.push(`set ${name}=1`);
  }
  if (spec.model === "tool-capable") {
    if (!present(env, "OPENWORK_EVAL_MODEL")) missing.push("set OPENWORK_EVAL_MODEL");
    if (!present(env, "OPENAI_API_KEY") && !present(env, "ANTHROPIC_API_KEY")) {
      missing.push("set OPENAI_API_KEY or ANTHROPIC_API_KEY");
    }
  }
  if (spec.daytona && env.OPENWORK_EVAL_DAYTONA?.trim() !== "1") {
    missing.push("set OPENWORK_EVAL_DAYTONA=1");
  }
  return missing;
}

export function checkNeeds(spec: NeedsSpec, env: NodeJS.ProcessEnv): void {
  const missing = unmetNeeds(spec, env);
  if (missing.length > 0) throw new SkipError(missing.join(", "));
}

export function needs(spec: NeedsSpec): Record<never, never> {
  checkNeeds(spec, process.env);
  return {};
}
