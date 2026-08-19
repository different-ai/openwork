import { spawnSync } from "node:child_process";

export interface TestNeeds {
  model?: "tool-capable";
  env?: string[];
  optIn?: string[];
  commands?: string[];
  daytona?: boolean;
  placement?: "daytona" | "local";
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

export function unmetNeeds(requirements: TestNeeds, env: NodeJS.ProcessEnv): string[] {
  const missing: string[] = [];
  for (const name of requirements.env ?? []) {
    if (!present(env, name)) missing.push(`set ${name}`);
  }
  for (const name of requirements.optIn ?? []) {
    if (env[name]?.trim() !== "1") missing.push(`set ${name}=1`);
  }
  for (const command of requirements.commands ?? []) {
    const result = spawnSync(command, ["--version"], { stdio: "ignore", timeout: 10_000 });
    if (result.error || result.status !== 0) missing.push(`install ${command}`);
  }
  if (requirements.model === "tool-capable") {
    if (!present(env, "OPENWORK_EVAL_MODEL")) missing.push("set OPENWORK_EVAL_MODEL");
    if (!present(env, "OPENAI_API_KEY") && !present(env, "ANTHROPIC_API_KEY")) {
      missing.push("set OPENAI_API_KEY or ANTHROPIC_API_KEY");
    }
  }
  if (requirements.daytona && env.OPENWORK_EVAL_DAYTONA?.trim() !== "1") {
    missing.push("set OPENWORK_EVAL_DAYTONA=1");
  }
  if (requirements.placement === "daytona" && env.OPENWORK_EVAL_DAYTONA?.trim() !== "1") {
    missing.push("set OPENWORK_EVAL_DAYTONA=1");
  }
  if (
    requirements.placement === "local"
    && (env.OPENWORK_EVAL_DAYTONA?.trim() === "1" || present(env, "OPENWORK_EVAL_DEN_API_URL"))
  ) {
    missing.push("use local placement without OPENWORK_EVAL_DEN_API_URL");
  }
  return missing;
}

export function checkNeeds(requirements: TestNeeds, env: NodeJS.ProcessEnv): void {
  const missing = unmetNeeds(requirements, env);
  if (missing.length > 0) throw new SkipError(missing.join(", "));
}

export function needs(requirements: TestNeeds): Record<never, never> {
  checkNeeds(requirements, process.env);
  return {};
}
