import type { ExtensionActionContribution, ExtensionActionDescriptor } from "./action-contract.js";

export const OPENAI_IMAGE_GENERATION_EXTENSION_ID = "openai-image-generation";

export const OPENAI_IMAGE_GENERATION_EXTENSION_ACTIONS: readonly ExtensionActionDescriptor[] = [
  {
    extensionId: OPENAI_IMAGE_GENERATION_EXTENSION_ID,
    action: "status",
    title: "OpenAI image generation status",
    description: "Check whether OpenAI image generation is configured and ready for OpenWork extension actions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    extensionId: OPENAI_IMAGE_GENERATION_EXTENSION_ID,
    action: "image_generate",
    title: "Generate image artifact",
    description: "Generate a PNG image artifact using OpenAI image generation with gpt-image-2.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Image prompt to turn into an artifact." },
        filename: { type: "string", description: "Optional output filename without extension." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
];

export type GeneratedImageArtifact = {
  readonly path: string;
  readonly bytes: number;
  readonly model: string;
  readonly workspaceId: string;
};

export type OpenAiImageGenerationActionOperations = {
  readonly status: () => Promise<unknown>;
  readonly generate: (args: Readonly<Record<string, unknown>>, clientContext: Readonly<Record<string, unknown>>) => Promise<GeneratedImageArtifact>;
};

export function createOpenAiImageGenerationActionContributions(
  operations: OpenAiImageGenerationActionOperations,
): readonly ExtensionActionContribution[] {
  const status = OPENAI_IMAGE_GENERATION_EXTENSION_ACTIONS[0];
  const generate = OPENAI_IMAGE_GENERATION_EXTENSION_ACTIONS[1];
  return [
    {
      descriptor: status,
      execute: async ({ clientContext }) => ({
        ok: true,
        extensionId: status.extensionId,
        action: status.action,
        result: await operations.status(),
        context: clientContext,
      }),
    },
    {
      descriptor: generate,
      execute: async ({ args, clientContext }) => {
        const result = await operations.generate(args, clientContext);
        return {
          ok: true,
          extensionId: generate.extensionId,
          action: generate.action,
          path: result.path,
          result,
          context: clientContext,
        };
      },
    },
  ];
}
