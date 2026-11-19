import { permanentRedirect } from "next/navigation";
import { getEveryoneAgentsRoute } from "../../../_lib/den-org";

/** Agent permissions moved to Members › Teams: Everyone's Agents tab is the base every team changes. */
export default function AgentPermissionsPage() {
  permanentRedirect(getEveryoneAgentsRoute());
}
