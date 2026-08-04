import { TeamDetailScreen } from "../../../../_components/team-detail-screen";

export default async function TeamDetailPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  return <TeamDetailScreen teamId={teamId} />;
}
