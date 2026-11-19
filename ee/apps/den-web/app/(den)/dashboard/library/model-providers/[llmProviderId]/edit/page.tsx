import { LibrarySetupIntro } from "../../../../_components/library-setup-intro";
import { LlmProviderEditorScreen } from "../../../../_components/llm-provider-editor-screen";

export default async function EditLibraryModelProviderPage({ params }: { params: Promise<{ llmProviderId: string }> }) {
  const { llmProviderId } = await params;
  return (
    <>
      <LibrarySetupIntro introKey="library.models.key" />
      <LlmProviderEditorScreen llmProviderId={llmProviderId} library />
    </>
  );
}
