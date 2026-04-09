import { SkillHubEditorScreen } from "../../../_components/skill-hub-editor-screen";

export default async function EditSkillHubPage({
  params,
}: {
  params: Promise<{ skillHubId: string }>;
}) {
  const { skillHubId } = await params;

  return <SkillHubEditorScreen skillHubId={skillHubId} />;
}
