const shellStartupVariables = new Set([
  "BASH_ENV",
  "ENV",
  "PROMPT_COMMAND",
  "SHELLOPTS",
  "PS4",
]);

/** Test-harness boundary: do not source inherited shell hooks beside live credentials. */
export function sanitizedLiveProofEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name]) => !shellStartupVariables.has(name)));
}
