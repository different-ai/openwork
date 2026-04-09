import { SkillHubDetailScreen } from "../../_components/skill-hub-detail-screen";

export default async function SkillHubPage({
  params,
}: {
  params: Promise<{ skillHubId: string }>;
}) {
  const { skillHubId } = await params;

  return <SkillHubDetailScreen skillHubId={skillHubId} />;
}
