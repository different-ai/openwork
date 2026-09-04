import { CoworkerTemplateEditor } from "../../../../../_components/coworker-template-editor";

export default async function CoworkerTemplatePage({ params }: { params: Promise<{ pluginId: string; coworkerId: string }> }) {
  const { pluginId, coworkerId } = await params;
  return <CoworkerTemplateEditor pluginId={pluginId} coworkerId={coworkerId} />;
}
