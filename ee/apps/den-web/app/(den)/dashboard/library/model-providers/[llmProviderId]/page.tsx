import { LlmProviderDetailScreen } from "../../../_components/llm-provider-detail-screen";

export default async function LibraryModelProviderPage({ params }: { params: Promise<{ llmProviderId: string }> }) {
  const { llmProviderId } = await params;
  return <LlmProviderDetailScreen llmProviderId={llmProviderId} library />;
}
