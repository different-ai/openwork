type SystemTransformOutput = {
  system: string[];
};

export function mergeSystemPromptsInPlace(system: string[]): void {
  const merged = system
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join("\n\n");

  // Keep the same array reference for hook callers that hold onto it.
  system.length = 0;
  if (merged) system.push(merged);
}

export const OpenWorkSystemPromptNormalizer = async () => ({
  "experimental.chat.system.transform": async (_input: unknown, output: SystemTransformOutput) => {
    mergeSystemPromptsInPlace(output.system);
  },
});
