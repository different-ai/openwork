import { SkillDetailScreen } from "../../../../../_components/skill-detail-screen";

export default async function LibraryPluginSkillPage({
  params,
}: {
  params: Promise<{ pluginId: string; skillId: string }>;
}) {
  const { pluginId, skillId } = await params;
  return <SkillDetailScreen pluginId={decodeURIComponent(pluginId)} skillId={decodeURIComponent(skillId)} mode="member" />;
}
