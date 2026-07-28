import { SkillEditorScreen } from "../../../../../_components/skill-editor-screen";

export default async function NewPluginSkillPage({
  params,
}: {
  params: Promise<{ pluginId: string }>;
}) {
  const { pluginId } = await params;
  return <SkillEditorScreen pluginId={pluginId} />;
}
