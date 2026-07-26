import { SkillDetailScreen } from "../../../../../_components/skill-detail-screen";

export default async function PluginSkillDetailPage({
  params,
}: {
  params: Promise<{ pluginId: string; skillId: string }>;
}) {
  const { pluginId, skillId } = await params;
  return <SkillDetailScreen pluginId={pluginId} skillId={skillId} />;
}
