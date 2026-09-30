import { GatewayLimitEditorScreen } from "../../../../_components/gateway-limit-editor-screen";

export default async function NewAiGatewayLimitPage({
  searchParams,
}: {
  searchParams: Promise<{ memberId?: string | string[]; teamId?: string | string[] }>;
}) {
  const { memberId, teamId } = await searchParams;
  const member = typeof memberId === "string" && memberId ? memberId : undefined;
  const team = typeof teamId === "string" && teamId ? teamId : undefined;
  const target = member ? { memberId: member } : team ? { teamId: team } : undefined;
  return <GatewayLimitEditorScreen key={member ?? team ?? "new"} target={target} />;
}
