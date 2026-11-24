import { permanentRedirect } from "next/navigation";
import { getEveryoneAgentsRoute } from "../../../_lib/den-org";

export default function AgentPermissionsPage() {
  permanentRedirect(getEveryoneAgentsRoute());
}
