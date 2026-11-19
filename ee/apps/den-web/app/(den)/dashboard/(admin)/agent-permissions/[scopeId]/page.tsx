import { permanentRedirect } from "next/navigation";
import { getEveryoneAgentsRoute, getTeamAgentsRoute } from "../../../../_lib/den-org";

/** "everyone" opens Everyone's Agents tab; a team's id opens that team's Agents tab. */
export default async function AgentPermissionsScopePage({
  params,
}: {
  params: Promise<{ scopeId: string }>;
}) {
  const { scopeId } = await params;
  const scope = decodeURIComponent(scopeId);
  permanentRedirect(scope === "everyone" ? getEveryoneAgentsRoute() : getTeamAgentsRoute(null, scope));
}
