/** Select the advertised Cloud entry surface, not the App host's private routers.
 * execute_capability_script also exists in standard mode; only capability_helper
 * identifies the opt-in surface. A partial pair must still fail readiness.
 */
export function cloudMcpRequiredTools(present: readonly string[] = [], prefix = ""): string[] {
  const names = present.includes(`${prefix}capability_helper`)
    ? ["execute_capability_script", "capability_helper"]
    : ["search_capabilities", "execute_capability"];
  return names.map((name) => `${prefix}${name}`);
}

/** Metadata alone is not proof that a client kept private App routers out. */
export function cloudMcpCodeModeProjectionSafe(present: readonly string[], prefix = "openwork-cloud_"): boolean {
  return ["execute_capability_script", "capability_helper"].every((name) => present.includes(`${prefix}${name}`))
    && ["search_capabilities", "execute_capability"].every((name) => !present.includes(`${prefix}${name}`));
}
