import { SkillDetailScreen } from "../../../_components/skill-detail-screen";

export default async function SkillPage({
  params,
}: {
  params: Promise<{ skillId: string }>;
}) {
  const { skillId } = await params;

  return <SkillDetailScreen skillId={skillId} />;
}
