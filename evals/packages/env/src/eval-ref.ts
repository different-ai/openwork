/** True when placement resolves to Daytona, mirroring resolvePlace. */
export function daytonaPlacement(env: NodeJS.ProcessEnv = process.env): boolean {
  const worldPlace = env.OPENWORK_WORLD_PLACE?.trim() || undefined;
  return worldPlace === "daytona" || (worldPlace === undefined && env.OPENWORK_EVAL_DAYTONA?.trim() === "1");
}

/** The git ref a Daytona sandbox checks out and builds. */
export function resolveEvalRef(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENWORK_EVAL_REF?.trim() || env.GITHUB_SHA?.trim() || "dev";
}

/**
 * The ref the sandbox builds, or undefined when the product runs from this
 * checkout. Specs always execute from the runner's checkout, so evidence needs
 * both this and the runner's own gitSha to name the product it judged.
 */
export function resolveSandboxRef(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return daytonaPlacement(env) ? resolveEvalRef(env) : undefined;
}
