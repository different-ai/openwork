type SystemTransformOutput = {
  system: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpenAICompatibleModel(input: unknown): boolean {
  if (!isRecord(input) || !isRecord(input.model) || !isRecord(input.model.api)) return false;
  return input.model.api.npm === "@ai-sdk/openai-compatible";
}

/**
 * OpenAI-compatible chat templates commonly require the only system message to
 * be the first message. Keep every existing system-hook contribution in its
 * original order, but collapse the prefix to one wire message. Conversation
 * messages are not available to this hook and are never promoted.
 */
function normalizeOpenAICompatibleSystem(
  input: unknown,
  output: SystemTransformOutput,
): void {
  if (!isOpenAICompatibleModel(input) || output.system.length < 2) return;
  const combined = output.system.filter((entry) => entry.length > 0).join("\n\n");
  output.system.splice(0, output.system.length, combined);
}

export const OpenWorkOpenAICompatibleSystem = async () => ({
  "experimental.chat.system.transform": async (input: unknown, output: SystemTransformOutput) => {
    normalizeOpenAICompatibleSystem(input, output);
  },
});
