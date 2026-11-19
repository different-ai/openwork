import { permanentRedirect } from "next/navigation";
import { getMembersTeamsRoute } from "../../../../_lib/den-org";

/** A team's changes are made on its own Agents tab, so creating one starts from Members › Teams. */
export default function NewTeamAgentPermissionsPage() {
  permanentRedirect(getMembersTeamsRoute());
}
