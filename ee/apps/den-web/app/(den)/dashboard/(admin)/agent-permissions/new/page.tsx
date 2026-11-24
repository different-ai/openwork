import { permanentRedirect } from "next/navigation";
import { getMembersTeamsRoute } from "../../../../_lib/den-org";

export default function NewTeamAgentPermissionsPage() {
  permanentRedirect(getMembersTeamsRoute());
}
