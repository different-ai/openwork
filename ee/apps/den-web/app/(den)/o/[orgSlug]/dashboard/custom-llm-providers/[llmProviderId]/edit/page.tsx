import { LlmProviderEditorScreen } from "../../../_components/llm-provider-editor-screen";

export default async function EditLlmProviderPage({
  params,
}: {
  params: Promise<{ llmProviderId: string }>;
}) {
  const { llmProviderId } = await params;
  return <LlmProviderEditorScreen llmProviderId={llmProviderId} />;
}
