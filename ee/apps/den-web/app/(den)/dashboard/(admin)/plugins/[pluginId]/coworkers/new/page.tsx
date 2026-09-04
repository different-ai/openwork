import { CoworkerTemplateEditor } from "../../../../../_components/coworker-template-editor";

export default async function NewCoworkerTemplatePage({ params }: { params: Promise<{ pluginId: string }> }) {
  const { pluginId } = await params;
  return <CoworkerTemplateEditor pluginId={pluginId} />;
}
