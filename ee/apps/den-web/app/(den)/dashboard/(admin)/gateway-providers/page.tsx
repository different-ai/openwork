import { redirect } from "next/navigation";
import { getAiGatewayProvidersRoute } from "../../../_lib/den-org";

// Gateway providers moved into AI Gateway. Desktop 0.18.55–0.18.57 still opens this address.
export default function GatewayProvidersPage() {
  redirect(getAiGatewayProvidersRoute());
}
