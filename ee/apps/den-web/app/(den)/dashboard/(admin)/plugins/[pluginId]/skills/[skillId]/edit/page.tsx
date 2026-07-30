import { SkillEditorScreen } from "../../../../../../_components/skill-editor-screen";

export default async function EditPluginSkillPage({
  params,
}: {
  params: Promise<{ pluginId: string; skillId: string }>;
}) {
  const { pluginId, skillId } = await params;
  return <SkillEditorScreen pluginId={pluginId} skillId={skillId} />;
}
