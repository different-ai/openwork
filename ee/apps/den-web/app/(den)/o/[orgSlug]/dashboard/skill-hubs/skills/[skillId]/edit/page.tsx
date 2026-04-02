import { SkillEditorScreen } from "../../../../_components/skill-editor-screen";

export default async function EditSkillPage({
  params,
}: {
  params: Promise<{ skillId: string }>;
}) {
  const { skillId } = await params;

  return <SkillEditorScreen skillId={skillId} />;
}
